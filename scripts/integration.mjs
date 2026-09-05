#!/usr/bin/env node
// Real MCP integration journey, no mocks:
//   initialize handshake -> upstream launch of the real Bevy fixture ->
//   live BRP queries -> bridge agent tools -> extras -> shutdown.
//
// Requires `bevy_brp_mcp` on PATH (or BEVY_BRP_MCP_BIN) and the fixture
// debug build (`cargo build -p bevy-mcp-fixture`). Runs the upstream binary
// through bin/bevy-plugin.mjs — the exact wrapper we ship.

import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 15702;
const FIXTURE = 'bevy-mcp-fixture';
const CALL_TIMEOUT = 30_000;
const LAUNCH_TIMEOUT = 300_000; // first run may compile the fixture
const READY_TIMEOUT = 60_000;
const EXIT_TIMEOUT = 20_000;

const REQUIRED_TOOLS = [
  'brp_list_bevy',
  'brp_launch',
  'world_query',
  'brp_type_guide',
  'world_get_components_watch',
  'brp_list_agent_tools',
  'brp_execute',
  'brp_extras_screenshot',
  'brp_extras_get_diagnostics',
];

function log(message) {
  console.log(`[integration] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Poll `fn` until it returns a truthy value; resolves to that value. Errors
// and falsy results are retried until the budget runs out, then it throws.
async function eventually(fn, { label, timeoutMs = READY_TIMEOUT, delayMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(delayMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function main() {
  const client = new Client({ name: 'bevy-plugin-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['bin/bevy-plugin.mjs'],
    cwd: repoRoot,
    stderr: 'inherit',
    // The SDK's default env whitelist drops DISPLAY — without the full env the
    // fixture launched under xvfb-run cannot open a window and panics in winit.
    env: { ...process.env },
  });
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'bevy-plugin-integration-'));

  // Lifecycle state for cleanup: is the fixture up, and is it shut down yet?
  let fixtureUp = false;

  async function callTool(name, args = {}, timeoutMs = CALL_TIMEOUT) {
    log(`-> ${name}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`);
    const res = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    assert.ok(!res.isError, `${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  }

  async function shutdownFixture() {
    if (!fixtureUp) return;
    const result = await callTool('brp_shutdown', { app_name: FIXTURE, port: PORT });
    fixtureUp = false;
    const pid = result?.metadata?.pid;
    assert.ok(typeof pid === 'number' && pid > 0, `shutdown must report a pid, got ${pid}`);
    await eventually(() => !processAlive(pid), {
      label: `fixture process ${pid} to exit`,
      timeoutMs: EXIT_TIMEOUT,
      delayMs: 250,
    });
    log(`fixture process ${pid} exited (${result?.metadata?.method ?? 'shutdown'})`);
  }

  async function dumpFixtureLog() {
    // ponytail: best-effort only — log reading must never mask the real failure
    try {
      const listed = await client.callTool(
        { name: 'brp_list_logs', arguments: { app_name: FIXTURE, verbose: false } },
        { timeout: 15_000 },
      );
      assert.ok(!listed.isError, `list_logs failed: ${JSON.stringify(listed.content)}`);
      const logs = listed.structuredContent?.result?.logs ?? [];
      if (!logs.length) {
        console.error('[integration] fixture log: (no log files recorded)');
        return;
      }
      const newest = logs[logs.length - 1];
      const res = await client.callTool(
        { name: 'brp_read_log', arguments: { filename: newest.filename, tail_lines: 80 } },
        { timeout: 15_000 },
      );
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      if (text.trim()) console.error(`[integration] fixture log (${newest.filename}):\n${text}`);
    } catch (err) {
      console.error(`[integration] fixture log dump failed: ${err.message}`);
    }
  }

  let failed = false;
  let serverPid;
  try {
    // --- Journey step 1: real MCP initialize handshake -----------------------
    log('connecting MCP client to bin/bevy-plugin.mjs');
    await client.connect(transport);
    serverPid = transport.pid;
    log(`initialized (server pid ${serverPid})`);

    // --- Journey step 2: upstream generic tool surface ------------------------
    log('listing upstream tools');
    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));
    for (const required of REQUIRED_TOOLS) {
      assert.ok(toolNames.has(required), `upstream tool ${required} missing`);
    }
    log(`all ${REQUIRED_TOOLS.length} required tools present (${tools.length} total)`);

    // --- Journey step 3: brp_list_bevy locates the fixture --------------------
    const listed = await callTool('brp_list_bevy', { path: repoRoot });
    const targets = listed?.result ?? [];
    const fixtureTarget = targets.find((t) => t.name === FIXTURE);
    assert.ok(fixtureTarget, `expected ${FIXTURE} among targets: ${targets.map((t) => t.name).join(', ')}`);
    log(`located ${FIXTURE} (${fixtureTarget.kind}, package ${fixtureTarget.package_name})`);

    // --- Journey step 4: brp_launch the fixture on port 15702 -----------------
    const launched = await callTool(
      'brp_launch',
      { target_name: FIXTURE, path: repoRoot, port: PORT },
      LAUNCH_TIMEOUT,
    );
    log(`launch ok: ${launched?.message ?? '(no message)'}`);
    fixtureUp = true;

    // --- Journey step 5: live BRP — world_query on the reflected fixture component
    const markerType = await eventually(async () => {
      const res = await client.callTool(
        { name: 'world_list_components', arguments: { port: PORT } },
        { timeout: CALL_TIMEOUT },
      );
      assert.ok(!res.isError, `world_list_components failed: ${JSON.stringify(res.content)}`);
      return (res.structuredContent?.result ?? []).find((name) => name.endsWith('::FixtureMarker'));
    }, { label: `fixture BRP server on port ${PORT} exposing FixtureMarker` });
    log(`discovered component ${markerType}`);

    const queried = await callTool('world_query', { data: { components: [markerType] }, port: PORT });
    const markerEntities = queried?.metadata?.entity_count;
    assert.equal(markerEntities, 2, `expected 2 FixtureMarker entities, got ${markerEntities}`);
    log(`world_query returned ${markerEntities} FixtureMarker entities`);

    // --- Journey step 6: bridge agent tools appear in the upstream catalog ----
    const agentTools = await callTool('brp_list_agent_tools', { port: PORT });
    const catalog = agentTools?.result?.tools ?? [];
    const byName = Object.fromEntries(catalog.map((t) => [t.name, t]));
    for (const name of ['bevy_mcp_world_stats', 'bevy_mcp_time_control']) {
      const entry = byName[name];
      assert.ok(entry, `agent tool ${name} missing from catalog: ${catalog.map((t) => t.name).join(', ')}`);
      assert.ok(entry.params_schema && typeof entry.params_schema === 'object', `${name} params_schema missing`);
      assert.ok(entry.result_schema && typeof entry.result_schema === 'object', `${name} result_schema missing`);
      assert.match(entry.method, /^bevy_mcp\//, `${name} must map to a bevy_mcp/ method`);
    }
    log('bevy_mcp_world_stats + bevy_mcp_time_control present with params/result schemas');

    // --- Journey step 7: brp_execute bevy_mcp/world_stats { limit: 1 } --------
    const stats = await callTool('brp_execute', {
      method: 'bevy_mcp/world_stats',
      params: { limit: 1 },
      port: PORT,
    });
    const statsResult = stats?.result ?? {};
    assert.equal(statsResult.returned, 1, `expected exactly 1 component row, got ${statsResult.returned}`);
    assert.equal(statsResult.components?.length, 1, 'components must carry exactly one row');
    assert.equal(statsResult.truncated, true, 'truncated must be true when more components exist than limit');
    assert.ok(typeof statsResult.entities === 'number' && statsResult.entities > 0, 'entity count missing');
    log(
      `world_stats ok: ${statsResult.entities} entities, top component ${statsResult.components[0].name}, truncated=${statsResult.truncated}`,
    );

    // --- Journey step 8: time control through pause, set-scale 2.0, resume ----
    async function timeControl(params) {
      const result = await callTool('brp_execute', {
        method: 'bevy_mcp/time_control',
        params,
        port: PORT,
      });
      return result?.result ?? {};
    }

    log('time_control: pause');
    assert.equal((await timeControl({ action: 'pause' })).paused, true, 'pause must report paused=true');
    log('time_control: set_scale 2.0');
    assert.equal(
      (await timeControl({ action: 'set_scale', scale: 2.0 })).relative_speed,
      2,
      'set_scale must report relative_speed=2',
    );
    log('time_control: resume');
    assert.equal((await timeControl({ action: 'resume' })).paused, false, 'resume must report paused=false');
    log('time control journey ok (pause -> scale 2 -> resume)');

    // --- Journey step 9: brp_extras_get_diagnostics ----------------------------
    const diagnostics = await callTool('brp_extras_get_diagnostics', { port: PORT });
    assert.ok(diagnostics, 'diagnostics must return a structured result');
    log(`diagnostics ok: ${diagnostics?.message ?? '(no message)'}`);

    // --- Journey step 10: brp_extras_screenshot to a temp PNG ------------------
    const screenshotPath = path.join(tmpDir, 'fixture.png');
    await callTool('brp_extras_screenshot', { path: screenshotPath, port: PORT });
    assert.ok(existsSync(screenshotPath), 'screenshot file must exist');
    assert.ok(statSync(screenshotPath).size > 0, 'screenshot file must be non-empty');
    log(`screenshot ok (${statSync(screenshotPath).size} bytes)`);

    // --- Journey step 11: shutdown the fixture and verify the process exits ----
    await shutdownFixture();
    log('PASS');
  } catch (err) {
    failed = true;
    console.error(`[integration] FAIL: ${err.message}`);
    if (fixtureUp) await dumpFixtureLog();
    // Best-effort cleanup so a failed run leaves no orphan or port squatter.
    try {
      await shutdownFixture();
    } catch {
      // best-effort; the original failure is already logged above
    }
  } finally {
    await client.close().catch(() => {});
    if (serverPid && processAlive(serverPid)) {
      const exited = await eventually(() => !processAlive(serverPid), {
        label: 'upstream server exit',
        timeoutMs: 10_000,
        delayMs: 250,
      }).catch(() => false);
      if (!exited) {
        console.error(`[integration] WARNING: upstream server ${serverPid} still running after close`);
        failed = true;
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
    if (failed) process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[integration] FAIL: ${err.message}`);
  process.exit(1);
});
