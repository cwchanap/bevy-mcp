import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Signal-handler smoke: the REAL built server (build/index.js) must exit
// promptly on SIGINT/SIGTERM after running the ordered cleanup, with the
// conventional 128+signal code and nothing on stderr (a cleanup failure would
// print there). Tracked-child termination through the same cleanup is covered
// by ProcessManager tests (fakes plus a real spawned child).
//
// Readiness: the tests complete an MCP initialize handshake first — the
// signal handlers are installed before `server.connect()`, so a completed
// handshake guarantees the handlers exist (no fixed-sleep race against cold
// Node startup).
//
// Gate order builds before testing (`npm run build` -> `npm test`); a missing
// entrypoint FAILS rather than skips.

const ENTRY = fileURLToPath(new URL('../../build/index.js', import.meta.url));

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'signal-smoke', version: '0.0.0' },
  },
});

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Spawn the server and resolve once its initialize response arrives. */
function startServerUntilReady(): Promise<{ child: ChildProcess; exited: Promise<Exit> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('"id":1')) {
        child.stdout!.off('data', onStdout);
        resolve({
          child,
          exited: new Promise((res) => {
            child.stderr!.on('data', (c) => {
              stderr += c;
            });
            child.once('error', reject);
            child.once('exit', (code, signal) => res({ code, signal, stderr }));
          }),
        });
      }
    };
    child.stdout!.on('data', onStdout);
    let stderrAll = '';
    child.stderr!.on('data', (c) => {
      stderrAll += c;
    });
    child.once('exit', (code, signal) =>
      reject(new Error(`server exited before readiness (exit ${code} ${signal}): ${stderrAll}`)),
    );
    child.stdin!.write(`${INITIALIZE}\n`);
  });
}

for (const [signal, expectedCode] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const) {
  test(`the owned server runs ordered cleanup and exits on ${signal}`, async () => {
    assert.ok(existsSync(ENTRY), 'build/index.js missing — run npm run build first');
    const { child, exited } = await startServerUntilReady();
    const sentAt = Date.now();
    child.kill(signal);

    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`server did not exit on ${signal}`)), 10_000),
      ),
    ]);
    assert.equal(result.signal, null, 'exited via process.exit, not a fatal signal');
    assert.equal(result.code, expectedCode);
    assert.equal(result.stderr, '', 'cleanup must not fail (stderr must stay clean)');
    assert.ok(Date.now() - sentAt < 10_000, 'cleanup does not hang');
  });
}
