#!/usr/bin/env node
// Early live smoke for the owned server's name-discovery composite:
//   build the fixture if needed -> start it on BRP port 15702 ->
//   start build/owned-index.js over stdio MCP -> world_find_entities_by_name
//   for FixturePrimary -> assert exactly one match with a safe entity id ->
//   close both processes. Exit 0 on pass, 1 on any failure.
//
// macOS note: run directly with `node` — the fixture opens a real window.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 15702;
const FIXTURE_BIN = path.join(repoRoot, 'target/debug/bevy-mcp-fixture');
const READY_TIMEOUT_MS = 60_000;

function log(message) {
  console.log(`[name-smoke] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrpReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover' }),
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body?.result?.methods)) return;
      }
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`BRP endpoint on port ${PORT} not ready after ${READY_TIMEOUT_MS}ms`);
}

async function main() {
  if (!existsSync(FIXTURE_BIN)) {
    log('fixture binary missing, running cargo build -p bevy-mcp-fixture');
    const built = spawnSync('cargo', ['build', '-p', 'bevy-mcp-fixture'], { stdio: 'inherit' });
    assert.equal(built.status, 0, 'cargo build -p bevy-mcp-fixture failed');
  }

  const fixture = spawn(FIXTURE_BIN, [], {
    cwd: repoRoot,
    env: { ...process.env, BRP_EXTRAS_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixtureLog = [];
  fixture.stdout.on('data', (chunk) => fixtureLog.push(chunk));
  fixture.stderr.on('data', (chunk) => fixtureLog.push(chunk));
  let exitCode = 1;
  let serverPid;

  try {
    fixture.on('exit', (code) => log(`fixture exited (code ${code})`));
    log(`fixture started (pid ${fixture.pid}), waiting for BRP on port ${PORT}`);
    await waitForBrpReady();
    log('BRP endpoint ready');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['build/owned-index.js'],
      cwd: repoRoot,
      stderr: 'inherit',
      // Full env: the owned server must be able to reach the fixture exactly
      // like the production wrapper does.
      env: { ...process.env },
    });
    const client = new Client({ name: 'bevy-plugin-name-smoke', version: '1.0.0' });
    await client.connect(transport);
    serverPid = transport.pid;
    log(`connected to build/owned-index.js (pid ${serverPid})`);

    const res = await client.callTool(
      { name: 'world_find_entities_by_name', arguments: { name: 'FixturePrimary' } },
      { timeout: 30_000 },
    );
    assert.ok(!res.isError, `tool call failed: ${JSON.stringify(res.content)}`);
    const env = res.structuredContent ?? {};
    assert.equal(env.status, 'success', `envelope status: ${env.status} (${env.message})`);
    assert.equal(env.message, 'Found 1 named entities');
    const matches = env.result ?? [];
    assert.equal(matches.length, 1, `expected exactly one match, got ${matches.length}`);
    const match = matches[0];
    assert.equal(match.name, 'FixturePrimary');
    assert.equal(
      typeof match.entity,
      'number',
      `entity id must be a JSON number, got ${typeof match.entity}`,
    );
    assert.ok(
      Number.isSafeInteger(match.entity) && match.entity > 0,
      `entity id must be a safe positive integer, got ${match.entity}`,
    );
    log(`PASS: FixturePrimary is entity ${match.entity}`);

    await client.close();
    exitCode = 0;
  } catch (err) {
    console.error(`[name-smoke] FAIL: ${err.message}`);
    const tail = fixtureLog.join('').split('\n').slice(-30).join('\n');
    if (tail.trim()) console.error(`[name-smoke] fixture log tail:\n${tail}`);
  } finally {
    if (serverPid) {
      try {
        process.kill(serverPid, 0);
        console.error(`[name-smoke] WARNING: owned server ${serverPid} still running after close`);
        exitCode = 1;
      } catch {
        // exited as expected
      }
    }
    if (fixture.exitCode === null && !fixture.signalCode) {
      fixture.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => fixture.once('exit', resolve)),
        sleep(5000).then(() => {
          console.error('[name-smoke] WARNING: fixture ignored SIGTERM, sending SIGKILL');
          fixture.kill('SIGKILL');
          exitCode = 1;
        }),
      ]);
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[name-smoke] FAIL: ${err.message}`);
  process.exit(1);
});
