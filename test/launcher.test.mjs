import test from 'node:test';
import assert from 'node:assert/strict';
import { launchUpstream } from '../src/launcher.mjs';

// Fake spawn: records its call and emits 'error' or 'close' on the child.
function fakeSpawn({ code = 0, error = null } = {}) {
  const calls = [];
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const listeners = {};
    const child = {
      on(event, fn) {
        (listeners[event] ??= []).push(fn);
        return child;
      },
      kill() {},
    };
    queueMicrotask(() => {
      if (error) {
        for (const fn of listeners.error ?? []) fn(error);
      } else {
        for (const fn of listeners.close ?? []) fn(code);
      }
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('default command is bevy_brp_mcp', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  await launchUpstream({ argv: [], env: {}, spawnImpl });
  assert.equal(calls[0].command, 'bevy_brp_mcp');
});

test('BEVY_BRP_MCP_BIN overrides the default command', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  await launchUpstream({ argv: [], env: { BEVY_BRP_MCP_BIN: '/custom/brp' }, spawnImpl });
  assert.equal(calls[0].command, '/custom/brp');
});

test('CLI args are passed through unchanged', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  const argv = ['--foo', 'bar', '--baz'];
  await launchUpstream({ argv, env: {}, spawnImpl });
  assert.deepEqual(calls[0].args, ['--foo', 'bar', '--baz']);
});

test('spawn uses stdio inherit', async () => {
  const { spawnImpl, calls } = fakeSpawn();
  await launchUpstream({ argv: [], env: {}, spawnImpl });
  assert.equal(calls[0].opts.stdio, 'inherit');
});

test('child exit code is mirrored', async () => {
  const { spawnImpl } = fakeSpawn({ code: 7 });
  const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
  assert.equal(await done, 7);
});

test('ENOENT prints the prerequisite command and exits 1', async () => {
  const enoent = Object.assign(new Error("spawn bevy_brp_mcp ENOENT"), { code: 'ENOENT' });
  const { spawnImpl } = fakeSpawn({ error: enoent });
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => (chunks.push(String(chunk)), true);
  try {
    const { done } = launchUpstream({ argv: [], env: {}, spawnImpl });
    assert.equal(await done, 1);
  } finally {
    process.stderr.write = original;
  }
  assert.match(chunks.join(''), /cargo install bevy_brp_mcp --version 0\.22\.3 --locked/);
});
