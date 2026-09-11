import test from 'node:test';
import assert from 'node:assert/strict';
import { createCleanup, exitAfterCleanup, type ShutdownSteps } from '../src/cleanup.js';

// The ordered cleanup backs src/index.ts's stdin-EOF and signal paths. Its
// load-bearing contract: a failed shutdownProcesses (a tracked child that
// survived SIGTERM/SIGKILL and stays tracked) must REJECT the cleanup —
// resolving would turn a failed child cleanup into a successful shutdown
// and let the signal handler's process.exit orphan that child.

function steps(overrides: Partial<ShutdownSteps> = {}): ShutdownSteps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    stopWatches: async () => {
      order.push('watches');
      await overrides.stopWatches?.();
    },
    shutdownProcesses: async () => {
      order.push('processes');
      await overrides.shutdownProcesses?.();
    },
    closeServer: async () => {
      order.push('server');
      await overrides.closeServer?.();
    },
  };
}

// createCleanup logs failures to stderr; silence it so the failure cases
// stay quiet like the passing cases.
function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test('cleanup runs watches -> processes -> server in order and resolves', async () => {
  const s = steps();
  const cleanup = createCleanup(s);
  await cleanup();
  assert.deepEqual(s.order, ['watches', 'processes', 'server']);
});

test('cleanup shares ONE in-flight run across callers', async () => {
  let shutdownCalls = 0;
  const s = steps({
    shutdownProcesses: async () => {
      shutdownCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  });
  const cleanup = createCleanup(s);
  await Promise.all([cleanup(), cleanup(), cleanup()]);
  assert.equal(shutdownCalls, 1, 'concurrent callers await the same cleanup run');
  assert.equal(s.order.filter((step) => step === 'server').length, 1);
});

test('a failed process shutdown still closes the server and rejects the cleanup', async () => {
  const restore = silenceConsoleError();
  try {
    const failure = new Error('Process 4242 did not exit within 5000ms after SIGKILL');
    const s = steps({
      shutdownProcesses: async () => {
        throw failure;
      },
    });
    const cleanup = createCleanup(s);

    await assert.rejects(cleanup(), failure);
    // server.close() was still attempted after the failed child shutdown.
    assert.deepEqual(s.order, ['watches', 'processes', 'server']);
  } finally {
    restore();
  }
});

test('a rejected cleanup does not latch: a later attempt re-runs the steps and exits', async () => {
  const restore = silenceConsoleError();
  try {
    // First shutdown attempt fails (a tracked child survives termination);
    // a later signal must retry shutdownAll rather than reusing the settled
    // rejection — only the successful attempt may exit.
    let failProcesses = true;
    const s = steps({
      shutdownProcesses: async () => {
        if (failProcesses) throw new Error('child survived SIGKILL');
      },
    });
    const cleanup = createCleanup(s);
    const exitCalls: number[] = [];

    exitAfterCleanup(cleanup, 143, (code) => exitCalls.push(code));
    await assert.rejects(cleanup());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(exitCalls, [] as number[], 'failed attempt must not exit');

    s.order.length = 0;
    failProcesses = false;
    exitAfterCleanup(cleanup, 143, (code) => exitCalls.push(code));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(s.order, ['watches', 'processes', 'server'], 'retry re-runs all steps');
    assert.deepEqual(exitCalls, [143], 'only the successful attempt exits');
  } finally {
    restore();
  }
});

test('the explicit exit path is skipped when cleanup rejects', async () => {
  const restore = silenceConsoleError();
  try {
    const s = steps({
      shutdownProcesses: async () => {
        throw new Error('child survived SIGKILL');
      },
    });
    const cleanup = createCleanup(s);

    const exitCalls: number[] = [];
    exitAfterCleanup(cleanup, 143, (code) => exitCalls.push(code));
    await assert.rejects(cleanup());
    // Flush the .then chain once more so a buggy exit call would be seen.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(exitCalls, [], 'a surviving tracked child must not be orphaned by process.exit');
  } finally {
    restore();
  }
});

test('the explicit exit path runs with the signal code after clean cleanup', async () => {
  const s = steps();
  const cleanup = createCleanup(s);

  const exitCalls: number[] = [];
  exitAfterCleanup(cleanup, 130, (code) => exitCalls.push(code));
  await cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(exitCalls, [130]);
});
