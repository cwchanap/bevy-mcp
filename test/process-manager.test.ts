import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { ProcessManager, type SpawnImpl } from '../src/runtime/process-manager.js';

const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-process-manager-'));
test.after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

interface KillRecord {
  signal: NodeJS.Signals;
}

/** Fake child: records kill signals, exits only when exit() is called. */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: KillRecord[] = [];
  unrefCalled = false;

  constructor(private readonly diesOnSigterm = false) {
    super();
  }

  kill = (signal?: NodeJS.Signals): boolean => {
    this.kills.push({ signal: signal ?? 'SIGTERM' });
    if (signal === 'SIGKILL' || this.diesOnSigterm) {
      // Exit asynchronously, like a real process reacting to a signal.
      queueMicrotask(() => this.exit(null, signal ?? 'SIGKILL'));
    }
    return true;
  };

  unref = (): void => {
    this.unrefCalled = true;
  };

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  opts: SpawnOptions;
  child: FakeChild;
}

function fakeSpawnHarness({ diesOnSigterm = false } = {}): {
  spawnImpl: SpawnImpl;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl: SpawnImpl = (command, args, opts) => {
    const child = new FakeChild(diesOnSigterm);
    calls.push({ command, args, opts, child });
    return child as unknown as ChildProcess;
  };
  return { spawnImpl, calls };
}

const LAUNCH = {
  appName: 'demo',
  executable: '/tmp/demo/target/debug/demo',
  port: 15702,
  logPath: join(BASE, 'demo.log'),
} as const;

test('launch spawns referenced children with the contractual env merge order', () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 20);
  const originalPath = process.env.PATH;
  process.env.PATH = '/process';
  try {
    manager.launch({
      ...LAUNCH,
      args: ['--flag', 'value'],
      // User env must beat process.env but lose to the assigned port.
      env: { PATH: '/user', BRP_EXTRAS_PORT: '99999', MINE: 'yes' },
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  const call = calls[0]!;
  assert.equal(call.command, LAUNCH.executable);
  assert.deepEqual(call.args, ['--flag', 'value']);
  const env = call.opts.env as Record<string, string>;
  assert.equal(env.PATH, '/user', 'user env beats process.env');
  assert.equal(env.MINE, 'yes');
  assert.equal(env.BRP_EXTRAS_PORT, '15702', 'assigned port beats user env');
  assert.equal(call.opts.stdio?.[0], 'ignore');
  // stdout and stderr share the LogStore-provided append handle; the log
  // file itself is created by the append-mode open.
  assert.equal(typeof call.opts.stdio?.[1], 'number');
  assert.equal(call.opts.stdio?.[1], call.opts.stdio?.[2]);
  assert.equal(call.opts.cwd, undefined);
  // Children stay referenced: never unref()ed.
  assert.equal(call.child.unrefCalled, false);
});

test('launch forwards cwd to the spawned child', () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 20);
  manager.launch({ ...LAUNCH, cwd: BASE });
  assert.equal(calls[0]!.opts.cwd, BASE);
});

test('launch tracks children until exit; exited children leave findByApp', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 20);
  const tracked = manager.launch(LAUNCH);

  assert.equal(tracked.pid, 4242);
  assert.deepEqual(manager.findByApp('demo'), [tracked]);
  assert.equal(tracked.isAlive(), true);

  calls[0]!.child.exit(0, null);
  await tracked.exited;
  assert.equal(tracked.isAlive(), false);
  assert.deepEqual(manager.findByApp('demo'), []);
});

test('terminate escalates SIGTERM -> bounded wait -> SIGKILL', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness({ diesOnSigterm: false });
  const manager = new ProcessManager(spawnImpl, 25);
  const tracked = manager.launch(LAUNCH);

  await manager.terminate(tracked);

  assert.deepEqual(
    calls[0]!.child.kills.map((k) => k.signal),
    ['SIGTERM', 'SIGKILL'],
  );
  await tracked.exited;
  assert.equal(tracked.isAlive(), false);
});

test('terminate stops at SIGTERM when the child exits on it', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness({ diesOnSigterm: true });
  const manager = new ProcessManager(spawnImpl, 30);
  const tracked = manager.launch(LAUNCH);

  await manager.terminate(tracked);

  assert.deepEqual(
    calls[0]!.child.kills.map((k) => k.signal),
    ['SIGTERM'],
  );
});

test('terminate is a no-op on already-exited children', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 20);
  const tracked = manager.launch(LAUNCH);
  calls[0]!.child.exit(0, null);
  await tracked.exited;

  await manager.terminate(tracked);

  assert.equal(calls[0]!.child.kills.length, 0);
});

test('waitForExit resolves within the timeout only when the child exits', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 20);
  const tracked = manager.launch(LAUNCH);

  const stillRunning = await manager.waitForExit(tracked, 15);
  assert.equal(stillRunning, false);

  calls[0]!.child.exit(3, null);
  await tracked.exited;
  const exited = await manager.waitForExit(tracked, 15);
  assert.equal(exited, true);
});

test('waitForExit clears the losing timer so it cannot delay exit', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness();
  const manager = new ProcessManager(spawnImpl, 60_000);
  const tracked = manager.launch(LAUNCH);

  // The child wins the race against a 60s bounded-wait timer.
  const pending = manager.waitForExit(tracked, 60_000);
  calls[0]!.child.exit(0, null);
  assert.equal(await pending, true);

  // One macrotask for the clear to land, then no live Timeout handle may
  // remain: otherwise a losing grace timer would keep the process alive.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const liveTimers = (process as unknown as {
    _getActiveHandles(): object[];
  })._getActiveHandles().filter((handle) => {
    const timeout = handle as { constructor?: { name?: string }; _destroyed?: boolean };
    return timeout.constructor?.name === 'Timeout' && timeout._destroyed !== true;
  });
  assert.deepEqual(liveTimers, []);
});

test('shutdownAll terminates a real spawned child (SIGTERM reaches the process)', async () => {
  const manager = new ProcessManager(); // real nodeSpawn
  const tracked = manager.launch({
    appName: 'real-child',
    executable: process.execPath,
    args: ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'],
    port: 15702,
    logPath: join(BASE, 'real-child.log'),
  });
  assert.equal(tracked.isAlive(), true);

  await manager.shutdownAll();
  await tracked.exited;
  assert.equal(tracked.isAlive(), false, 'the real child was terminated');
});

test('shutdownAll terminates every tracked child and is idempotent', async () => {
  const { spawnImpl, calls } = fakeSpawnHarness({ diesOnSigterm: true });
  const manager = new ProcessManager(spawnImpl, 20);
  manager.launch(LAUNCH);
  manager.launch({ ...LAUNCH, appName: 'other', port: 15703 });

  await manager.shutdownAll();
  assert.deepEqual(
    calls.flatMap((call) => call.child.kills.map((k) => k.signal)),
    ['SIGTERM', 'SIGTERM'],
  );
  assert.deepEqual(manager.findByApp('demo'), []);
  assert.deepEqual(manager.findByApp('other'), []);

  // Second call: nothing tracked, no further signals, resolves cleanly.
  await manager.shutdownAll();
  assert.equal(calls.flatMap((call) => call.child.kills).length, 2);
});

test('launch throws synchronously when the child has no pid (spawn failure)', () => {
  const spawnImpl: SpawnImpl = () => {
    const child = new FakeChild();
    child.pid = undefined as unknown as number;
    // Node emits 'error' asynchronously on real spawn failures.
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child as unknown as ChildProcess;
  };
  const manager = new ProcessManager(spawnImpl, 20);
  assert.throws(() => manager.launch(LAUNCH), /Failed to spawn/);
});
