import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { launchUpstream, type SpawnImpl } from '../src/launcher.js';

interface SpawnCall {
  command: string;
  args: readonly string[];
  opts: SpawnOptions;
}

function fakeSpawn({ code = 0, error = null }: { code?: number; error?: NodeJS.ErrnoException | null } = {}) {
  const calls: SpawnCall[] = [];
  const spawnImpl: SpawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter() as ChildProcess;
    child.kill = (() => true) as ChildProcess['kill'];
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('default command is bevy_brp_mcp', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
  await done;
  assert.equal(calls[0].command, 'bevy_brp_mcp');
});

test('BEVY_BRP_MCP_BIN overrides the default command', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const { done } = launchUpstream({ argv: [], env: { BEVY_BRP_MCP_BIN: '/custom/brp' }, spawnImpl });
  await done;
  assert.equal(calls[0].command, '/custom/brp');
});

test('CLI args are passed through unchanged', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const argv = ['--foo', 'bar', '--baz'];
  const { done } = launchUpstream({ argv, env: {}, spawnImpl });
  await done;
  assert.deepEqual(calls[0].args, argv);
});

test('spawn uses stdio inherit', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
  await done;
  assert.equal(calls[0].opts.stdio, 'inherit');
});

test('child exit code is mirrored', async () => {
  const { spawnImpl } = fakeSpawn({ code: 7 });
  const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
  assert.equal(await done, 7);
});

test('ENOENT prints the prerequisite command and exits 1', async () => {
  const enoent = Object.assign(new Error('spawn bevy_brp_mcp ENOENT'), { code: 'ENOENT' });
  const { spawnImpl } = fakeSpawn({ error: enoent });
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
    assert.equal(await done, 1);
  } finally {
    process.stderr.write = original;
  }
  assert.match(chunks.join(''), /cargo install bevy_brp_mcp --version 0\.22\.3 --locked/);
});
