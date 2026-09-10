#!/usr/bin/env node
// Packed-CLI smoke test: proves npm packaging works without cargo.
//
// 1. `npm pack` the repo into a temp dir.
// 2. Install the tarball into that temp dir.
// 3. Connect to the installed `bevy-plugin` bin over StdioClientTransport.
// 4. Assert the packed owned server advertises all 47 tools matching the
//    captured contract (after the reviewed description overrides).
// 5. Close the client and verify the server process exits.
// 6. Clean up the temp dir.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_TIMEOUT = 120_000;
const TOOL_TIMEOUT = 30_000;
const EXIT_TIMEOUT = 15_000;

function log(message) {
  console.log(`[smoke:packed] ${message}`);
}

function run(cmd, args, { cwd, timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, env: process.env, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the pid is gone or the deadline passes; true = exited. */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !processAlive(pid);
}

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'bevy-plugin-smoke-'));
  let serverPid;
  let client;
  let serverLeaked = false;
  try {
    log('npm pack into temp dir');
    const packJson = await run(
      'npm',
      ['pack', '--json', '--pack-destination', tmpDir],
      { cwd: repoRoot, timeout: NPM_TIMEOUT },
    );
    const packed = JSON.parse(packJson)[0];
    const tarball = path.join(tmpDir, packed.filename);
    log(`packed ${packed.name}@${packed.version} -> ${packed.filename}`);

    log('installing tarball into temp dir');
    await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], {
      cwd: tmpDir,
      timeout: NPM_TIMEOUT,
    });

    const binPath = path.join(tmpDir, 'node_modules', '.bin', 'bevy-plugin');
    log('connecting to the packed bevy-plugin bin over stdio MCP');
    client = new Client({ name: 'bevy-plugin-smoke', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: binPath,
      cwd: tmpDir,
      stderr: 'inherit',
      env: { ...process.env },
    });
    await client.connect(transport);
    serverPid = transport.pid;
    log(`connected (server pid ${serverPid})`);

    const { tools } = await client.listTools();
    const contract = JSON.parse(
      readFileSync(path.join(repoRoot, 'contracts', 'bevy-brp-mcp-0.22.3-tools.json'), 'utf8'),
    ).tools;
    assert.equal(tools.length, contract.length, `expected ${contract.length} tools from the packed bin`);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const captured of contract) {
      const advertised = byName[captured.name];
      assert.ok(advertised, `tool ${captured.name} missing from the packed bin`);
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
    log(`all ${contract.length} tools verified against the captured contract`);
  } finally {
    if (client !== undefined) {
      try {
        await client.close();
      } finally {
        // Whether assertions passed or failed, the packed server must not
        // outlive this script: close was issued, so give it the exit window,
        // then terminate it and await the reap before exiting.
        if (serverPid !== undefined) {
          log('client closed; waiting for the packed server to exit');
          if (await waitForExit(serverPid, EXIT_TIMEOUT)) {
            log(`packed server ${serverPid} exited cleanly`);
          } else {
            console.error(
              `[smoke:packed] WARNING: packed server ${serverPid} still running after close; sending SIGKILL`,
            );
            process.kill(serverPid, 'SIGKILL');
            await waitForExit(serverPid, 5_000);
            serverLeaked = true;
          }
        }
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
  assert.ok(!serverLeaked, `packed server ${serverPid} must exit after close`);
}

main()
  .then(() => {
    log('PASS');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[smoke:packed] FAIL: ${err.message}`);
    process.exit(1);
  });
