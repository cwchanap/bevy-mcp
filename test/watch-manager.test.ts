import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrpCallOptions, BrpClient } from '../src/brp/client.js';
import { LogStore } from '../src/runtime/log-store.js';
import {
  parseSseDataLine,
  SseLineSplitter,
  WatchManager,
} from '../src/runtime/watch-manager.js';

// Isolated LogStore root per test file (node:test runs files as processes).
const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-watch-mgr-'));
test.after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

function makeLogStore(): LogStore {
  return new LogStore(join(BASE, `case-${Math.random().toString(36).slice(2)}`));
}

/** Collect lines from arbitrary chunks, including a final flush. */
function feed(chunks: string[]): string[] {
  const splitter = new SseLineSplitter();
  const lines: string[] = [];
  for (const chunk of chunks) lines.push(...splitter.push(chunk));
  const tail = splitter.flush();
  if (tail !== undefined) lines.push(tail);
  return lines;
}

interface FakeStream {
  brp: BrpClient;
  calls: { method: string; params: unknown; port?: number; signal?: AbortSignal }[];
  send(text: string): void;
  close(): void;
  fail(error: Error): void;
}

/** A BrpClient whose `stream()` returns a real Response over a pushable body
 * (a fresh body per call: a Response locks its stream after first use). */
function fakeStreamBrp(failConnect?: Error): FakeStream {
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const calls: FakeStream['calls'] = [];
  const brp = {
    async stream(method: string, params: unknown, options: BrpCallOptions = {}) {
      calls.push({ method, params, port: options.port, signal: options.signal });
      if (failConnect) throw failConnect;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controllers.add(c);
          },
        }),
        { status: 200 },
      );
    },
  } as unknown as BrpClient;
  return {
    brp,
    calls,
    send: (text) => {
      for (const controller of controllers) controller.enqueue(encoder.encode(text));
    },
    close: () => {
      for (const controller of controllers) controller.close();
    },
    fail: (error) => {
      for (const controller of controllers) controller.error(error);
    },
  };
}

/** Poll until `check()` holds or the deadline passes (pump runs in background). */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('SSE splitter: a data line is found no matter where chunks split it', () => {
  const event = 'data: {"jsonrpc":"2.0","result":{"a":1}}\n\n';
  for (let split = 0; split <= event.length; split += 1) {
    const lines = feed([event.slice(0, split), event.slice(split)]);
    assert.deepEqual(lines, [
      'data: {"jsonrpc":"2.0","result":{"a":1}}',
      '',
    ], `split at ${split}`);
  }
});

test('SSE splitter: CRLF and LF endings, blank lines, multiple events per chunk', () => {
  const lines = feed([
    'data: {"result":1}\r\ndata: {"result":2}\n\ndata: {"result":3}\r\n\r\ndata: {"result":4}\n',
  ]);
  // Blank lines are complete lines too (SSE event boundaries); the data-line
  // parser skips them later, so the splitter must surface them unchanged.
  assert.deepEqual(lines, [
    'data: {"result":1}',
    'data: {"result":2}',
    '',
    'data: {"result":3}',
    '',
    'data: {"result":4}',
  ]);
});

test('SSE splitter: final line without newline survives via flush', () => {
  assert.deepEqual(feed(['data: {"result":1}\ndata: {"result":2}']), [
    'data: {"result":1}',
    'data: {"result":2}',
  ]);
  assert.deepEqual(feed([]), []);
});

test('SSE parse: valid results pass; malformed and non-data lines never crash', () => {
  assert.deepEqual(parseSseDataLine('data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}'), {
    ok: true,
    result: { x: 1 },
  });
  assert.deepEqual(parseSseDataLine('data: {"jsonrpc":"2.0","result":[1,2]}'), {
    ok: true,
    result: [1, 2],
  });
  for (const bad of [
    '',
    'event: message',
    ': keep-alive comment',
    'data:',
    'data:{no-space}',
    'data: {malformed json',
    'data: {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}}',
    'data: {"jsonrpc":"2.0","id":1}',
  ]) {
    assert.equal(parseSseDataLine(bad).ok, false, `line must not parse: ${JSON.stringify(bad)}`);
  }
});

test('unsafe 64-bit integers in SSE records log an error record, loop continues', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startGetComponents(42, ['A']);

  const unsafeLine = `data: {"jsonrpc":"2.0","id":1,"result":{"entity_id":${2 ** 63}}}`;
  fake.send(`${unsafeLine}\n`);
  fake.send('data: {"jsonrpc":"2.0","id":2,"result":{"components":["A"]}}\n');
  fake.close();

  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.includes('WATCH_ENDED');
  }, 'the watch to end');

  const log = await logStore.read(watch.filename);
  assert.ok(log.content.includes('ERROR'), 'an ERROR record names the failure');
  assert.ok(log.content.includes('entity_id'), 'the error names the unsafe value path');
  assert.ok(log.content.includes('unsafe integer'), 'the error explains the precision failure');
  // The corrupted record is never logged as a COMPONENT_UPDATE...
  assert.ok(!log.content.includes('"entity_id":9223372036854776000'));
  // ...and the corrupted value itself appears nowhere in the log — the error
  // record names only the path.
  assert.ok(!log.content.includes('9223372036854776000'));
  // ...and the stream stays alive: the next safe record still lands.
  assert.ok(log.content.includes('"components":["A"]'), 'loop continues after the error record');
  assert.ok(log.content.includes('WATCH_ENDED'));
  assert.deepEqual(manager.list(), []);

  // Unit level: the unsafe line parses to the unsafe outcome, not ok/junk.
  const parsed = parseSseDataLine(unsafeLine);
  assert.equal(parsed.ok, false);
  assert.ok('unsafe' in parsed && parsed.unsafe);
});

test('safe large integers in SSE records are unaffected by the guard', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startListComponents(7);

  fake.send(`data: {"jsonrpc":"2.0","id":1,"result":{"count":${2 ** 40},"scale":2.5}}\n`);
  fake.close();

  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.includes('WATCH_ENDED');
  }, 'the watch to end');

  const log = await logStore.read(watch.filename);
  assert.ok(!log.content.includes('ERROR'), 'safe values raise no error');
  assert.ok(log.content.includes(`"count":${2 ** 40}`));
  assert.ok(log.content.includes('"scale":2.5'));
});

test('get watch uses world.get_components+watch, registers id 1, logs WATCH_STARTED', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startGetComponents(42, ['bevy_ecs::name::Name']);

  assert.equal(watch.id, 1);
  assert.equal(watch.kind, 'get_components');
  assert.deepEqual(watch.types, ['bevy_ecs::name::Name']);
  assert.equal(watch.port, 15702);
  assert.match(watch.filename, /^bevy-mcp_watch_1_get_42_\d+\.log$/);
  assert.ok(watch.path.endsWith(join('watches', watch.filename)), 'watch log lives in the watches root');
  assert.equal(fake.calls[0]?.method, 'world.get_components+watch');
  assert.deepEqual(fake.calls[0]?.params, { entity: 42, components: ['bevy_ecs::name::Name'] });

  const active = manager.list();
  assert.deepEqual(active.map((entry) => entry.watch_id), [1]);
  assert.equal(active[0]?.log_path, watch.path);

  const started = await logStore.read(watch.filename);
  assert.ok(started.content.includes('WATCH_STARTED'));
  assert.ok(started.content.includes('"entity":42'));
});

test('list watch uses world.list_components+watch and monotonic ids from 1', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);

  const first = await manager.startListComponents(7);
  const second = await manager.startGetComponents(7, ['A']);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(first.kind, 'list_components');
  assert.equal(first.types, undefined);
  assert.equal(fake.calls[0]?.method, 'world.list_components+watch');
  assert.deepEqual(fake.calls[0]?.params, { entity: 7 });

  const active = manager.list();
  assert.deepEqual(active.map((watch) => watch.watch_id), [1, 2]);
  assert.deepEqual(
    active.map((watch) => watch.watch_type),
    ['list', 'get'],
  );
  assert.ok(active.every((watch) => watch.log_path.includes('watches')));
  assert.deepEqual(active.map((watch) => watch.entity_id), [7, 7]);
});

test('valid results become COMPONENT_UPDATE records; junk lines are skipped', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startGetComponents(42, ['A']);

  fake.send('data: {"jsonrpc":"2.0","id":1,"result":{"components":["A"]}}\n');
  fake.send('data: {broken json\n');
  fake.send(': sse comment\n\n');
  fake.send('data: {"jsonrpc":"2.0","id":2,"error":{"code":-32601}}\n');
  fake.send('data: {"jsonrpc":"2.0","id":3,"result":{"components":["A","B"]}}\n');
  fake.close();

  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.split('COMPONENT_UPDATE').length === 3; // WATCH_STARTED + 2 updates + ENDED
  }, 'two COMPONENT_UPDATE records');

  const log = await logStore.read(watch.filename);
  assert.ok(log.content.includes('"components":["A"]'));
  assert.ok(log.content.includes('"components":["A","B"]'));
  assert.ok(!log.content.includes('broken json'), 'malformed payload must not be recorded as update');
  assert.ok(log.content.includes('WATCH_ENDED'));
  assert.deepEqual(manager.list(), [], 'ended watch is removed from the registry');
});

test('updates split across chunk boundaries are parsed', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startListComponents(42);

  fake.send('data: {"jsonrpc":"2.0",');
  fake.send('"result":{"components":["C1"]}');
  fake.send('}\n');
  fake.close();

  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.includes('C1');
  }, 'split update record');
  assert.deepEqual(manager.list(), []);
});

test('stream body error appends CONNECTION_ERROR and WATCH_ENDED, then deregisters', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startGetComponents(42, ['A']);

  fake.fail(new Error('connection reset'));
  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.includes('CONNECTION_ERROR') && log.content.includes('WATCH_ENDED');
  }, 'error and ended records');
  assert.deepEqual(manager.list(), []);
});

test('stop aborts the stream, deregisters, and logs ended without error', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const watch = await manager.startGetComponents(42, ['A']);

  assert.equal(manager.stop(watch.id), true);
  assert.deepEqual(manager.list(), []);
  assert.equal(fake.calls[0]?.signal?.aborted, true, 'stop aborts the stream signal');

  // Simulate the fetch body failing because of the abort.
  fake.fail(new Error('The request was aborted'));
  await until(async () => {
    const log = await logStore.read(watch.filename);
    return log.content.includes('WATCH_ENDED');
  }, 'ended record after stop');
  const log = await logStore.read(watch.filename);
  assert.ok(!log.content.includes('CONNECTION_ERROR'), 'a deliberate stop is not an error');

  assert.equal(manager.stop(watch.id), false, 'double stop is false');
  assert.equal(manager.stop(999), false, 'unknown id is false');
});

test('failed connection rejects the start and logs CONNECTION_ERROR', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp(new Error('ECONNREFUSED'));
  const manager = new WatchManager(logStore, fake.brp);

  await assert.rejects(
    () => manager.startGetComponents(42, ['A']),
    /ECONNREFUSED/,
  );
  assert.deepEqual(manager.list(), [], 'unestablished streams never register');
  const logs = await logStore.list();
  assert.equal(logs.length, 1, 'the allocated watch log still exists');
  const log = await logStore.read(logs[0]!.filename);
  assert.ok(log.content.includes('CONNECTION_ERROR'));
});

test('empty or missing types are rejected before starting', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  await assert.rejects(() => manager.startGetComponents(42, []), /cannot be empty/);
  assert.deepEqual(fake.calls, [], 'nothing is sent to BRP');
  assert.deepEqual(manager.list(), []);
});

test('stopAll aborts every active watch and clears the registry', async () => {
  const logStore = makeLogStore();
  const fake = fakeStreamBrp();
  const manager = new WatchManager(logStore, fake.brp);
  const first = await manager.startGetComponents(1, ['A']);
  const second = await manager.startListComponents(2);

  await manager.stopAll();
  assert.deepEqual(manager.list(), []);
  assert.equal(fake.calls[0]?.signal?.aborted, true);
  assert.equal(fake.calls[1]?.signal?.aborted, true);
  assert.equal(manager.stop(first.id), false);
  assert.equal(manager.stop(second.id), false);
});
