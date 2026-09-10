#!/usr/bin/env node
// Real MCP integration journey, no mocks:
//   initialize handshake -> launch of the real Bevy fixture -> live BRP
//   queries -> bridge agent tools -> extras -> watches -> logs -> shutdown.
//
// Runs the repository-owned server (build/index.js) and additionally checks
// the tools/list wire gate: all 47 entries must deep-equal the captured
// 0.22.3 contract after the reviewed description overrides.
//
// Requires the fixture debug build (`cargo build -p bevy-mcp-fixture`).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 15702;
const FIXTURE = 'bevy-mcp-fixture';
const CONTRACT_FILE = path.join(repoRoot, 'contracts', 'bevy-brp-mcp-0.22.3-tools.json');
const CALL_TIMEOUT = 30_000;
const LAUNCH_TIMEOUT = 300_000; // first run may compile the fixture
const READY_TIMEOUT = 60_000;
const EXIT_TIMEOUT = 20_000;

// Suffix-resolved full type names (resolved live from world_list_components).
const MARKER_SUFFIX = '::FixtureMarker';
const VALUE_SUFFIX = '::FixtureValue';
const MODE_SUFFIX = '::FixtureMode';
const STATE_SUFFIX = '::FixtureState';
const NAME_COMPONENT = 'bevy_ecs::name::Name';

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
  const argIndex = process.argv.indexOf('--server');
  const mode = argIndex !== -1 ? process.argv[argIndex + 1] : 'owned';
  if (mode !== 'owned') {
    console.error(`[integration] unknown --server mode: ${mode} (only "owned" exists)`);
    process.exit(2);
  }
  if (!existsSync(path.join(repoRoot, 'build/index.js'))) {
    throw new Error('build/index.js missing — run npm run build first');
  }
  await runJourney();
}

async function runJourney() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'bevy-plugin-integration-'));
  const client = new Client({ name: 'bevy-plugin-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    cwd: repoRoot,
    stderr: 'inherit',
    // The SDK's default env whitelist drops DISPLAY — without the full env the
    // fixture cannot open a window and panics in winit.
    env: { ...process.env },
  });
  await client.connect(transport);
  let fixtureUp = false;
  let failed = false;

  async function call(name, args = {}, timeoutMs = CALL_TIMEOUT) {
    log(`-> ${name}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`);
    const res = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    assert.ok(!res.isError, `${name} failed: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  }

  // Same, but for calls that are EXPECTED to produce an error envelope.
  async function callError(name, args = {}, timeoutMs = CALL_TIMEOUT) {
    log(`-> ${name} (expecting error) ${JSON.stringify(args)}`);
    const res = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
    assert.equal(res.isError, true, `${name} was expected to fail`);
    return res.structuredContent;
  }

  async function shutdownFixture() {
    if (!fixtureUp) return;
    const result = await call('brp_shutdown', { app_name: FIXTURE, port: PORT });
    const pid = result?.metadata?.pid;
    assert.ok(typeof pid === 'number' && pid > 0, `shutdown must report a pid, got ${pid}`);
    await eventually(() => !processAlive(pid), {
      label: `fixture process ${pid} to exit`,
      timeoutMs: EXIT_TIMEOUT,
      delayMs: 250,
    });
    fixtureUp = false;
    log(`fixture process ${pid} exited (${result?.metadata?.shutdown_method ?? 'shutdown'})`);
  }

  try {
    // --- tools/list wire gate: all 47 entries deep-equal the captured 0.22.3
    // contract after the reviewed description overrides. --------------------
    const { tools } = await client.listTools();
    const contract = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')).tools;
    assert.equal(tools.length, contract.length, `expected ${contract.length} tools`);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const captured of contract) {
      const advertised = byName[captured.name];
      assert.ok(advertised, `tool ${captured.name} missing from tools/list`);
      assert.equal(advertised.title, captured.title, `${captured.name}: title`);
      assert.equal(
        advertised.description,
        captured.description.replaceAll('bevy_brp_mcp', 'bevy-mcp'),
        `${captured.name}: description`,
      );
      assert.deepEqual(advertised.annotations, captured.annotations, `${captured.name}: annotations`);
      assert.deepEqual(advertised.inputSchema, captured.inputSchema, `${captured.name}: inputSchema`);
      assert.deepEqual(advertised.outputSchema, captured.outputSchema, `${captured.name}: outputSchema`);
    }
    log(`tools/list wire gate: all ${contract.length} entries match the captured contract`);

    // --- clean slate: drop this app's logs from any previous journey run ----
    await call('brp_delete_logs', { app_name: FIXTURE });

    // --- locate the fixture --------------------------------------------------
    const listed = await call('brp_list_bevy', { path: repoRoot });
    const targets = listed?.result ?? [];
    const fixtureTarget = targets.find((t) => t.name === FIXTURE);
    assert.ok(fixtureTarget, `expected ${FIXTURE} among targets: ${targets.map((t) => t.name).join(', ')}`);
    assert.equal(fixtureTarget.kind, 'app');
    // Upstream brp_level is a textual heuristic over the package src/ tree;
    // the fixture enables BRP transitively via bevy-mcp-bridge, so the
    // heuristic reports 'none' for it.
    assert.equal(fixtureTarget.brp_level, 'none');
    log(`located ${FIXTURE} (package ${fixtureTarget.package_name})`);

    // --- launch --------------------------------------------------------------
    const launched = await call(
      'brp_launch',
      { target_name: FIXTURE, path: repoRoot, port: PORT },
      LAUNCH_TIMEOUT,
    );
    fixtureUp = true;
    assert.equal(launched?.metadata?.launched_as, 'app');
    assert.equal(launched?.result?.length, 1);
    log(`launch ok: ${launched?.message ?? '(no message)'}`);

    // --- wait for the fixture BRP server -------------------------------------
    const componentTypes = await eventually(async () => {
      const res = await client.callTool(
        { name: 'world_list_components', arguments: { port: PORT } },
        { timeout: CALL_TIMEOUT },
      );
      assert.ok(!res.isError, `world_list_components failed: ${JSON.stringify(res.content)}`);
      const names = res.structuredContent?.result ?? [];
      return names.find((name) => name.endsWith(MARKER_SUFFIX)) ? names : null;
    }, { label: `fixture BRP server on port ${PORT} exposing FixtureMarker` });
    const markerType = componentTypes.find((name) => name.endsWith(MARKER_SUFFIX));
    const bySuffix = (suffix) => componentTypes.find((name) => name.endsWith(suffix));
    const valueType = bySuffix(VALUE_SUFFIX);
    const modeType = bySuffix(MODE_SUFFIX);
    const stateType = bySuffix(STATE_SUFFIX);
    log(`discovered component ${markerType}`);

    // --- world query + name find ---------------------------------------------
    const queried = await call('world_query', { data: { components: [markerType] }, port: PORT });
    assert.equal(queried?.metadata?.entity_count, 2, 'expected 2 FixtureMarker entities');
    const primary = await call('world_find_entities_by_name', { name: 'FixturePrimary', port: PORT });
    const entityId = primary?.result?.[0]?.entity;
    assert.ok(Number.isInteger(entityId), `expected a resolved entity id, got ${entityId}`);
    log(`world_find_entities_by_name resolved FixturePrimary -> entity ${entityId}`);

    // --- world get (deterministic reflected components) ----------------------
    const got = await call('world_get_components', {
      entity: entityId,
      components: [NAME_COMPONENT, valueType, modeType],
      port: PORT,
    });
    assert.equal(got?.result?.components?.[NAME_COMPONENT], 'FixturePrimary');

    // --- resources: list, get, insert, mutate --------------------------------
    const resources = await call('world_list_resources', { port: PORT });
    assert.ok(resources?.result?.includes(stateType), `expected ${stateType} among resources`);
    const gotResource = await call('world_get_resources', { resource: stateType, port: PORT });
    assert.equal(gotResource?.result?.value?.counter, 0);
    await call('world_insert_resources', {
      resource: stateType,
      value: { elapsed: 0, counter: 41 },
      port: PORT,
    });
    const gotUpdated = await call('world_get_resources', { resource: stateType, port: PORT });
    assert.equal(gotUpdated?.result?.value?.counter, 41, 'inserted resource value must be visible');
    await call('world_mutate_resources', {
      resource: stateType,
      path: 'counter',
      value: 42,
      port: PORT,
    });
    const gotMutated = await call('world_get_resources', { resource: stateType, port: PORT });
    assert.equal(gotMutated?.result?.value?.counter, 42, 'mutated resource value must be visible');
    log('resource get/insert/mutate journey ok');

    // --- spawn / insert / mutate / remove / despawn on a fresh entity --------
    const spawned = await call('world_spawn_entity', {
      components: { [NAME_COMPONENT]: 'JourneySpawned' },
      port: PORT,
    });
    const spawnedId = spawned?.result?.entity ?? spawned?.metadata?.entity;
    assert.ok(Number.isInteger(spawnedId), `spawn must report an entity id, got ${spawnedId}`);
    await call('world_insert_components', {
      entity: spawnedId,
      components: { [valueType]: { value: 5 } },
      port: PORT,
    });
    const gotSpawned = await call('world_get_components', {
      entity: spawnedId,
      components: [valueType],
      port: PORT,
    });
    assert.equal(gotSpawned?.result?.components?.[valueType]?.value, 5);
    await call('world_mutate_components', {
      entity: spawnedId,
      component: valueType,
      path: 'value',
      value: 6,
      port: PORT,
    });
    const gotMutatedEntity = await call('world_get_components', {
      entity: spawnedId,
      components: [valueType],
      port: PORT,
    });
    assert.equal(gotMutatedEntity?.result?.components?.[valueType]?.value, 6);
    await call('world_remove_components', {
      entity: spawnedId,
      components: [NAME_COMPONENT],
      port: PORT,
    });
    await call('world_despawn_entity', { entity: spawnedId, port: PORT });
    log(`spawn/insert/mutate/remove/despawn journey ok (entity ${spawnedId})`);

    // --- BRP error surfaces: despawned entity + unknown component -----------
    const deadEntity = await callError('world_get_components', {
      entity: spawnedId,
      components: [valueType],
      port: PORT,
    });
    assert.match(deadEntity.message, /\(error -\d+\)/, 'BRP error must carry the (error code) suffix');
    const unknownType = await callError('world_get_components', {
      entity: entityId,
      components: ['totally::fake::NotReal'],
      strict: true,
      port: PORT,
    });
    assert.match(unknownType.message, /\(error -\d+\)/, 'unknown-component error carries the (error code) suffix');
    log('BRP error enhancement journey ok');

    // --- agent tools + brp_execute -------------------------------------------
    const agentTools = await call('brp_list_agent_tools', { port: PORT });
    const catalog = agentTools?.result?.tools ?? [];
    const byToolName = Object.fromEntries(catalog.map((t) => [t.name, t]));
    for (const name of ['bevy_mcp_world_stats', 'bevy_mcp_time_control']) {
      const entry = byToolName[name];
      assert.ok(entry, `agent tool ${name} missing from catalog`);
      assert.ok(entry.params_schema && typeof entry.params_schema === 'object', `${name} params_schema missing`);
      assert.ok(entry.result_schema && typeof entry.result_schema === 'object', `${name} result_schema missing`);
      assert.match(entry.method, /^bevy_mcp\//, `${name} must map to a bevy_mcp/ method`);
    }
    log('bevy_mcp_world_stats + bevy_mcp_time_control present with schemas');

    const stats = await call('brp_execute', {
      method: 'bevy_mcp/world_stats',
      params: { limit: 1 },
      port: PORT,
    });
    const statsResult = stats?.result ?? {};
    assert.equal(statsResult.returned, 1);
    assert.equal(statsResult.truncated, true);
    assert.ok(typeof statsResult.entities === 'number' && statsResult.entities > 0);

    async function timeControl(params) {
      const result = await call('brp_execute', {
        method: 'bevy_mcp/time_control',
        params,
        port: PORT,
      });
      return result?.result ?? {};
    }
    assert.equal((await timeControl({ action: 'pause' })).paused, true);
    assert.equal((await timeControl({ action: 'set_scale', scale: 2.0 })).relative_speed, 2);
    assert.equal((await timeControl({ action: 'resume' })).paused, false);
    log('brp_execute world_stats + time control journey ok');

    // --- brp_execute discovery gate: unregistered method ---------------------
    const unregistered = await callError('brp_execute', {
      method: 'bevy_mcp/does_not_exist',
      port: PORT,
    });
    assert.match(unregistered.message, /is not registered on port/);
    assert.equal(unregistered.metadata?.stage, 'discovery');
    assert.ok(unregistered.metadata?.available_methods?.includes('bevy_mcp/world_stats'));
    log('brp_execute discovery gate ok');

    // --- extras: diagnostics, window title, screenshot -----------------------
    const diagnostics = await call('brp_extras_get_diagnostics', { port: PORT });
    assert.equal(diagnostics?.message, 'FPS diagnostics retrieved');
    const title = await call('brp_extras_set_window_title', {
      title: 'Bevy MCP Integration',
      port: PORT,
    });
    assert.match(title?.message, /Window title changed from '.*' to 'Bevy MCP Integration'/);
    const screenshotPath = path.join(tmpDir, 'fixture.png');
    await call('brp_extras_screenshot', { path: screenshotPath, port: PORT });
    assert.ok(existsSync(screenshotPath), 'screenshot file must exist');
    assert.ok(statSync(screenshotPath).size > 0, 'screenshot file must be non-empty');
    log('extras diagnostics/window-title/screenshot journey ok');

    // --- type guides ----------------------------------------------------------
    const modeGuide = await call('brp_type_guide', { types: [modeType], port: PORT });
    assert.ok(modeGuide?.result ?? modeGuide?.type_guide, 'type guide must return content');
    await call('brp_type_guide', { types: [NAME_COMPONENT], port: PORT });
    const allGuides = await call('brp_all_type_guides', { port: PORT });
    assert.match(allGuides?.message ?? '', /Discovered schemas for all \d+ registered type\(s\)/);
    // Representative inclusion when the full guide map is present (owned
    // returns the complete result; upstream 0.22.3 spills large bodies to a
    // file instead — the reviewed T6 divergence).
    const guideMap = allGuides?.result?.type_guide ?? allGuides?.result;
    if (guideMap && Object.keys(guideMap).some((key) => key.includes('::'))) {
      for (const requiredType of [modeType, NAME_COMPONENT]) {
        assert.ok(guideMap[requiredType], `all-type guides must include ${requiredType}`);
      }
    }
    log('type guide journey ok (single + all-type)');

    // --- native watch on a dedicated entity ----------------------------------
    const watchSpawn = await call('world_spawn_entity', {
      components: { [valueType]: { value: 7 } },
      port: PORT,
    });
    const watchEntity = watchSpawn?.result?.entity ?? watchSpawn?.metadata?.entity;
    assert.ok(Number.isInteger(watchEntity));
    const startGet = await call('world_get_components_watch', {
      entity: watchEntity,
      types: [valueType],
      port: PORT,
    });
    const watch1 = startGet?.metadata?.watch_id;
    assert.equal(watch1, 1, `first watch id must be 1, got ${watch1}`);
    const watch1Log = path.basename(startGet?.metadata?.log_path ?? '');
    await call('world_mutate_components', {
      entity: watchEntity,
      component: valueType,
      path: 'value',
      value: 99,
      port: PORT,
    });
    const startList = await call('world_list_components_watch', {
      entity: watchEntity,
      port: PORT,
    });
    const watch2 = startList?.metadata?.watch_id;
    assert.equal(watch2, 2, `second watch id must be 2, got ${watch2}`);
    // Change the entity's component list so the list watch records an update.
    await call('world_insert_components', {
      entity: watchEntity,
      components: { [NAME_COMPONENT]: 'Watched' },
      port: PORT,
    });

    // Observe the get-watch log: expect a COMPONENT_UPDATE carrying the
    // mutated value 99 (event presence, never timing).
    const observed = await eventually(async () => {
      const res = await client.callTool(
        {
          name: 'brp_read_log',
          arguments: { filename: watch1Log, keyword: 'COMPONENT_UPDATE', tail_lines: 50 },
        },
        { timeout: CALL_TIMEOUT },
      );
      assert.ok(!res.isError, `read_log failed: ${JSON.stringify(res.content)}`);
      const content = res.structuredContent?.result ?? '';
      return content.includes('99');
    }, { label: 'get-watch log to observe the value-99 COMPONENT_UPDATE' });
    assert.ok(observed, 'watch log must record the mutated value');
    log('native watch + mutation + log observation ok');

    // Observe the list-watch log the same way (component-list change).
    const observedList = await eventually(async () => {
      const res = await client.callTool(
        {
          name: 'brp_read_log',
          arguments: { filename: path.basename(startList?.metadata?.log_path ?? ''), keyword: 'COMPONENT_UPDATE', tail_lines: 50 },
        },
        { timeout: CALL_TIMEOUT },
      );
      assert.ok(!res.isError, `list watch read_log failed: ${JSON.stringify(res.content)}`);
      const content = res.structuredContent?.result ?? '';
      return content.includes(NAME_COMPONENT);
    }, { label: 'list-watch log to observe the Name component change' });
    assert.ok(observedList, 'list watch log must record the component change');

    const activeWatches = await call('brp_list_active_watches');
    assert.equal(activeWatches?.metadata?.watch_count, 2);
    await call('brp_stop_watch', { watch_id: watch1 });
    await call('brp_stop_watch', { watch_id: watch2 });
    log('watch start/observe/list/stop journey ok');

    // --- status + logs ---------------------------------------------------------
    const status = await call('brp_status', { app_name: FIXTURE, port: PORT });
    assert.match(status?.message ?? '', /is running with BRP enabled on port 15702/);
    const logList = await call('brp_list_logs', { app_name: FIXTURE, verbose: true });
    assert.ok((logList?.result ?? []).length >= 1, 'expected the app launch log among listed files');
    const appLogName = path.basename(launched?.result?.[0]?.log_file ?? '');
    assert.ok(appLogName.endsWith('.log'), 'launch must report the app log file');
    await call('brp_read_log', { filename: appLogName, tail_lines: 40 });
    log('status + list/read logs journey ok');

    // --- shutdown ---------------------------------------------------------------
    await shutdownFixture();
    log('PASS');
  } catch (err) {
    failed = true;
    console.error(`[integration] FAIL: ${err.message}`);
    try {
      await shutdownFixture();
    } catch {
      // best-effort; the original failure is already logged above
    }
  } finally {
    await client.close().catch(() => {});
    const exited = await eventually(() => !processAlive(transport.pid), {
      label: 'owned server exit',
      timeoutMs: 10_000,
      delayMs: 250,
    }).catch(() => false);
    if (!exited) {
      console.error(`[integration] WARNING: server ${transport.pid} still running after close`);
      failed = true;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`[integration] FAIL: ${err.message}`);
  process.exit(1);
});
