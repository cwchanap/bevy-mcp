import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../src/runtime/log-store.js';

// Isolated LogStore root per test file (node:test runs files as processes).
const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-log-store-'));
const logStore = new LogStore(BASE);

test.after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

test('createAppLog allocates bevy-mcp_{app}_{ts}.log under the apps root', async () => {
  const { filename, path } = await logStore.createAppLog('myapp');
  assert.match(filename, /^bevy-mcp_myapp_\d+\.log$/);
  assert.equal(path, join(BASE, 'apps', filename));
  assert.ok(await logStore.read(filename)); // resolvable through the owned roots
});

test('createAppLog sanitizes path traversal and hostile characters', async () => {
  const evil = await logStore.createAppLog('../../evil app!');
  assert.equal(evil.filename.includes('/'), false);
  assert.equal(evil.filename.includes('\\'), false);
  assert.match(evil.filename, /^bevy-mcp_[A-Za-z0-9._-]+_\d+\.log$/);
  assert.ok(evil.path.startsWith(join(BASE, 'apps')));
});

test('createWatchLog matches the captured naming contract exactly', async () => {
  const { filename, path } = await logStore.createWatchLog(1, 42, 'get');
  // Captured text (after the reviewed override): bevy-mcp_watch_{id}_{type}_{entity}_{ts}.log
  assert.match(filename, /^bevy-mcp_watch_1_get_42_\d+\.log$/);
  assert.equal(path, join(BASE, 'watches', filename));
  const listWatch = await logStore.createWatchLog(2, 42, 'list');
  assert.match(listWatch.filename, /^bevy-mcp_watch_2_list_42_\d+\.log$/);
});

test('list is minimal by default, newest first, and includes watch logs', async () => {
  const oldApp = await logStore.createAppLog('sortme');
  const newApp = await logStore.createAppLog('sortme');
  await logStore.createWatchLog(9, 7, 'list');
  const logs = await logStore.list();
  const names = logs.map((log) => log.filename);
  assert.ok(names.indexOf(newApp.filename) < names.indexOf(oldApp.filename), 'newest first');
  assert.ok(names.some((name) => name.startsWith('bevy-mcp_watch_9_list_7_')));
  for (const log of logs) {
    assert.deepEqual(Object.keys(log).sort(), ['app_name', 'filename']);
  }
});

test('list appName filter matches app logs only; verbose adds metadata', async () => {
  await logStore.createAppLog('filtered');
  await logStore.createWatchLog(5, 5, 'get');
  const filtered = await logStore.list({ appName: 'filtered' });
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((log) => log.app_name === 'filtered'));

  const verbose = await logStore.list({ appName: 'filtered', verbose: true });
  for (const log of verbose) {
    assert.equal(log.path, join(BASE, 'apps', log.filename));
    assert.equal(typeof log.size_bytes, 'number');
    assert.match(log.size as string, /^\d+(\.\d+)? B$|^\d+(\.\d{2})? (KB|MB|GB)$/);
    assert.match(log.modified as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(log.created as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
});

test('read returns upstream-compatible fields, keyword and tail support', async () => {
  const { filename } = await logStore.createAppLog('reader');
  const path = join(BASE, 'apps', filename);
  writeFileSync(
    path,
    [
      '[2026-01-01 10:00:00.000] WATCH_STARTED: {"entity":42}',
      '[2026-01-01 10:00:01.000] COMPONENT_UPDATE: {"Position":{"x":1}}',
      '[2026-01-01 10:00:02.000] COMPONENT_UPDATE: {"Position":{"x":2}}',
      '[2026-01-01 10:00:03.000] WATCH_ENDED: {"entity":42}',
      '',
    ].join('\n'),
  );

  const full = await logStore.read(filename);
  assert.equal(full.filename, filename);
  assert.equal(full.file_path, path);
  assert.equal(full.lines_read, 4);
  assert.equal(full.filtered_by_keyword, false);
  assert.equal(full.tail_mode, false);
  assert.ok(full.size_bytes > 0);
  assert.match(full.size_human, /^\d+ B$/);

  const keyword = await logStore.read(filename, { keyword: 'component_update' });
  assert.equal(keyword.lines_read, 2);
  assert.equal(keyword.filtered_by_keyword, true);
  assert.ok(keyword.content.includes('"x":2'));
  assert.ok(!keyword.content.includes('WATCH_STARTED'));

  const tail = await logStore.read(filename, { tailLines: 2 });
  assert.equal(tail.lines_read, 2);
  assert.equal(tail.tail_mode, true);
  // Tail takes the LAST two lines.
  assert.deepEqual(tail.content.split('\n'), [
    '[2026-01-01 10:00:02.000] COMPONENT_UPDATE: {"Position":{"x":2}}',
    '[2026-01-01 10:00:03.000] WATCH_ENDED: {"entity":42}',
  ]);
});

test('read tail beyond file size returns everything', async () => {
  const { filename } = await logStore.createAppLog('tailbig');
  const path = join(BASE, 'apps', filename);
  writeFileSync(path, 'one\ntwo\n');
  const result = await logStore.read(filename, { tailLines: 10 });
  assert.equal(result.lines_read, 2);
  assert.equal(result.content, 'one\ntwo');
});

test('read rejects traversal, absolute paths, separators, and foreign names', async () => {
  await logStore.createAppLog('guarded');
  for (const bad of [
    '../apps/bevy-mcp_guarded_1.log',
    'apps/bevy-mcp_guarded_1.log',
    join(BASE, 'apps', 'bevy-mcp_guarded_1.log'),
    '/etc/passwd',
    'bevy-mcp_guarded_1.log.bak',
    'otherapp_1.log',
    '..',
  ]) {
    await assert.rejects(() => logStore.read(bad), /only bevy-mcp log files can be read/);
  }
  await assert.rejects(
    () => logStore.read('bevy-mcp_nosuchfile_123.log'),
    /log file 'bevy-mcp_nosuchfile_123.log' not found/,
  );
});

test('delete by appName spares watch logs; delete all removes everything', async () => {
  const app = await logStore.createAppLog('doomed');
  await logStore.createWatchLog(77, 1, 'get');
  const deleted = await logStore.delete({ appName: 'doomed' });
  assert.deepEqual(deleted, [app.filename]);

  const all = await logStore.list();
  const watchName = all.find((log) => log.filename.includes('watch_77'))?.filename;
  assert.ok(watchName, 'watch log must survive the app-name delete');

  const everything = await logStore.delete({});
  assert.ok(everything.includes(watchName));
  assert.deepEqual(await logStore.list(), []);
});

test('read and delete refuse symlinks planted in the owned roots', async () => {
  // Fresh root so the probe cannot interact with other cases.
  const base = mkdtempSync(join(tmpdir(), 'bevy-mcp-log-symlink-'));
  const store = new LogStore(base);
  try {
    const { filename } = await store.createAppLog('realfile');
    const outside = join(base, 'outside-target.log');
    writeFileSync(outside, 'secret\n');
    const linkName = 'bevy-mcp_evil_1.log';
    symlinkSync(outside, join(base, 'apps', linkName));

    // read: the symlink is not an owned file and is never followed.
    await assert.rejects(() => store.read(linkName), /not found/);
    assert.equal(readFileSync(outside, 'utf8'), 'secret\n', 'target untouched by read');

    // list never surfaces it; delete never removes it (link or target).
    assert.ok(!(await store.list()).some((log) => log.filename === linkName));
    const deleted = await store.delete({});
    assert.ok(deleted.includes(filename), 'real owned files still delete');
    assert.ok(!deleted.includes(linkName), 'symlinks are not deleted');
    assert.ok(existsSync(join(base, 'apps', linkName)), 'the link itself survives');
    assert.equal(readFileSync(outside, 'utf8'), 'secret\n', 'target survives delete');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('concurrent same-second createAppLog calls allocate distinct files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'bevy-mcp-log-race-'));
  const store = new LogStore(base);
  try {
    // Same app name, same millisecond: the exclusive create must never
    // truncate one file to satisfy the other.
    const [a, b, c] = await Promise.all([
      store.createAppLog('racer'),
      store.createAppLog('racer'),
      store.createAppLog('racer'),
    ]);
    const names = new Set([a.filename, b.filename, c.filename]);
    assert.equal(names.size, 3, 'three distinct filenames');
    for (const allocation of [a, b, c]) {
      assert.match(allocation.filename, /^bevy-mcp_racer_\d+\.log$/);
      assert.ok(existsSync(allocation.path));
    }
    // All three remain readable through the owned roots.
    for (const name of names) assert.ok(await store.read(name));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('delete olderThanSeconds respects modification age', async () => {
  const old = await logStore.createAppLog('aged');
  const fresh = await logStore.createAppLog('fresh');
  const oldTime = new Date(Date.now() - 10_000);
  utimesSync(join(BASE, 'apps', old.filename), oldTime, oldTime);

  const deleted = await logStore.delete({ olderThanSeconds: 5 });
  assert.deepEqual(deleted, [old.filename]);
  const remaining = (await logStore.list()).map((log) => log.filename);
  assert.ok(remaining.includes(fresh.filename));
});
