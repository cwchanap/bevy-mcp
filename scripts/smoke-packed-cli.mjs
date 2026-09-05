#!/usr/bin/env node
// Packed-CLI smoke test: proves npm packaging works without cargo.
//
// 1. `npm pack` the repo into a temp dir.
// 2. Install the tarball into that temp dir.
// 3. Run the installed `bevy-plugin` bin with BEVY_BRP_MCP_BIN pointed at a
//    fake executable that speaks no MCP but records argv + stdio lifecycle.
// 4. Assert the packed bin delegated to the fake and mirrored its exit code.
// 5. Clean up the temp dir.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_TIMEOUT = 120_000;
const BIN_TIMEOUT = 30_000;
const FAKE_EXIT_CODE = 7;

function log(message) {
  console.log(`[smoke:packed] ${message}`);
}

function run(cmd, args, { cwd, timeout, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, env: env ?? process.env, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

// Fake upstream: records argv and stdin EOF, then exits with BEVY_FAKE_EXIT.
// It deliberately speaks no MCP — the wrapper is a thin exec passthrough.
const FAKE_BIN = `#!/bin/sh
{
  printf 'argv'
  for arg in "$@"; do printf ' %s' "\$arg"; done
  printf '\\n'
  cat > /dev/null
  printf 'stdin-eof\\n'
} >> "\$BEVY_FAKE_LOG"
exit "\$BEVY_FAKE_EXIT"
`;

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'bevy-plugin-smoke-'));
  let tarball;
  try {
    log('npm pack into temp dir');
    const packJson = await run(
      'npm',
      ['pack', '--json', '--pack-destination', tmpDir],
      { cwd: repoRoot, timeout: NPM_TIMEOUT },
    );
    const packed = JSON.parse(packJson)[0];
    tarball = path.join(tmpDir, packed.filename);
    log(`packed ${packed.name}@${packed.version} -> ${packed.filename}`);

    log('installing tarball into temp dir');
    await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], {
      cwd: tmpDir,
      timeout: NPM_TIMEOUT,
    });

    const fakeBin = path.join(tmpDir, 'fake-bevy-brp-mcp.sh');
    const fakeLog = path.join(tmpDir, 'fake.log');
    await writeFile(fakeBin, FAKE_BIN);
    await chmod(fakeBin, 0o755);

    log('running packed bevy-plugin bin against fake BEVY_BRP_MCP_BIN');
    const binPath = path.join(tmpDir, 'node_modules', '.bin', 'bevy-plugin');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(binPath, ['--smoke-arg', 'one'], {
        cwd: tmpDir,
        env: {
          ...process.env,
          BEVY_BRP_MCP_BIN: fakeBin,
          BEVY_FAKE_LOG: fakeLog,
          BEVY_FAKE_EXIT: String(FAKE_EXIT_CODE),
        },
        stdio: ['pipe', 'ignore', 'inherit'],
      });
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`packed bin timed out after ${BIN_TIMEOUT}ms`));
      }, BIN_TIMEOUT);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    log(`packed bin exited with code ${code}`);
    assert.equal(code, FAKE_EXIT_CODE, 'bin must mirror the fake binary exit code');

    const recorded = await readFile(fakeLog, 'utf8');
    assert.match(recorded, /^argv --smoke-arg one$/m, 'fake must receive the CLI argv');
    assert.match(recorded, /^stdin-eof$/m, 'fake must see stdin EOF (stdio wired through)');
    log('delegation + exit-code mirror verified');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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
