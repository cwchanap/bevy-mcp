import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { CargoRuntime } from '../src/runtime/cargo.js';
import { LogStore } from '../src/runtime/log-store.js';
import { ProcessManager } from '../src/runtime/process-manager.js';
import type { BevyMcpServices } from '../src/services.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';
import { registerLogTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';

// Isolated LogStore root per test file (node:test runs files as processes).
const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-log-tools-'));
test.after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

function harness(): {
  logStore: LogStore;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const logStore = new LogStore(join(BASE, `case-${Math.random().toString(36).slice(2)}`));
  const services: BevyMcpServices = {
    brp: {} as BevyMcpServices['brp'],
    cargo: new CargoRuntime(),
    catalog: loadToolContractCatalog(),
    logStore,
    watches: {} as BevyMcpServices['watches'],
    processes: new ProcessManager(() => {
      throw new Error('no spawn expected in this test');
    }),
  };
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerLogTools(server, services, loadToolContractCatalog());
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;
  return { logStore, call: (name, args = {}) => tools[name]!.handler(args) };
}

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

async function seedAppLog(logStore: LogStore, app: string, lines: string[]): Promise<string> {
  const { filename, path } = await logStore.createAppLog(app);
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return filename;
}

async function pathOf(logStore: LogStore, appName: string): Promise<string> {
  const listed = await logStore.list({ appName, verbose: true });
  assert.equal(listed.length, 1);
  return (listed[0] as { path: string }).path;
}

function ageFile(path: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
}

test('registerLogTools registers exactly the three log tools', () => {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  const services: BevyMcpServices = {
    brp: {} as BevyMcpServices['brp'],
    cargo: new CargoRuntime(),
    catalog: loadToolContractCatalog(),
    logStore: new LogStore(join(BASE, 'registry-only')),
    watches: {} as BevyMcpServices['watches'],
    processes: new ProcessManager(() => {
      throw new Error('no spawn expected in this test');
    }),
  };
  registerLogTools(server, services, loadToolContractCatalog());
  assert.deepEqual(
    Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort(),
    ['brp_delete_logs', 'brp_list_logs', 'brp_read_log'],
  );
});

test('brp_list_logs accepts only {app_name?, verbose?} and returns {logs} upstream-compatibly', async () => {
  const { logStore, call } = harness();
  await seedAppLog(logStore, 'myapp', ['hello']);
  await logStore.createWatchLog(3, 9, 'get');

  const result = await call('brp_list_logs');
  const env = envelope(result);
  assert.equal(result.isError, undefined);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Found 2 log files');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_list_logs' });
  // Upstream metadata carries the log directory alongside the count.
  assert.deepEqual(env.metadata, {
    temp_directory: logStore.directory,
    log_count: 2,
  });
  // Upstream `#[to_result]` places the bare array in `result`.
  const logs = env.result as { filename: string; app_name: string }[];
  assert.equal(logs.length, 2);
  for (const log of logs) {
    assert.deepEqual(Object.keys(log).sort(), ['app_name', 'filename'], 'minimal listing fields');
  }

  // Extra parameters are ignored per the captured schema (no
  // additionalProperties:false): no port, no caller-supplied path input.
  const filtered = envelope(
    await call('brp_list_logs', {
      app_name: 'myapp',
      verbose: false,
      port: 1234,
      path: '/absolute/path',
    }),
  );
  assert.equal(filtered.status, 'success');
  assert.deepEqual(filtered.metadata, {
    temp_directory: logStore.directory,
    log_count: 1,
  });
  const filteredLogs = filtered.result as { logs: unknown[] }[] | unknown[];
  const filteredList = Array.isArray(filteredLogs) ? filteredLogs : [];
  assert.equal(filteredList.length, 1);
  assert.equal((filteredList[0] as { app_name: string }).app_name, 'myapp');

  // verbose delegates to LogStore and adds the metadata fields.
  const verbose = envelope(await call('brp_list_logs', { app_name: 'myapp', verbose: true }));
  const verboseLogs = verbose.result as Record<string, unknown>[];
  const verboseLog = verboseLogs[0]!;
  assert.deepEqual(Object.keys(verboseLog).sort(), [
    'app_name',
    'created',
    'filename',
    'modified',
    'path',
    'size',
    'size_bytes',
  ]);
});

test('brp_read_log accepts only {filename, keyword?, tail_lines?} and splits content/metadata', async () => {
  const { logStore, call } = harness();
  const filename = await seedAppLog(logStore, 'reader', [
    '[t1] INFO: started',
    '[t2] ERROR: boom',
    '[t3] INFO: ready',
    '[t4] ERROR: kaboom',
  ]);

  const full = await call('brp_read_log', { filename });
  const fullEnv = envelope(full);
  assert.equal(fullEnv.status, 'success');
  assert.equal(fullEnv.message, 'Read 4 lines from ' + filename);
  assert.deepEqual(fullEnv.call_info, { mcp_tool: 'brp_read_log' });
  const fullMetadata = fullEnv.metadata as Record<string, unknown>;
  assert.equal(fullMetadata.filename, filename);
  assert.match(fullMetadata.file_path as string, /apps/);
  assert.equal(typeof fullMetadata.size_bytes, 'number');
  assert.match(fullMetadata.size_human as string, /\d/);
  assert.equal(fullMetadata.lines_read, 4);
  assert.equal(fullMetadata.filtered_by_keyword, false);
  assert.equal(fullMetadata.tail_mode, false);
  assert.equal(
    fullEnv.result,
    '[t1] INFO: started\n[t2] ERROR: boom\n[t3] INFO: ready\n[t4] ERROR: kaboom',
  );

  // Keyword filter (case-insensitive) delegates to LogStore.
  const keyword = envelope(await call('brp_read_log', { filename, keyword: 'ERROR' }));
  assert.equal((keyword.metadata as Record<string, unknown>).lines_read, 2);
  assert.equal((keyword.metadata as Record<string, unknown>).filtered_by_keyword, true);
  assert.equal(keyword.result, '[t2] ERROR: boom\n[t4] ERROR: kaboom');

  // Tail mode delegates to LogStore.
  const tail = envelope(await call('brp_read_log', { filename, tail_lines: 2 }));
  assert.equal((tail.metadata as Record<string, unknown>).lines_read, 2);
  assert.equal((tail.metadata as Record<string, unknown>).tail_mode, true);
  assert.equal(tail.result, '[t3] INFO: ready\n[t4] ERROR: kaboom');
});

test('brp_read_log rejects traversal, absolute paths, and unknown files through the tool layer', async () => {
  const { logStore, call } = harness();

  const traversal = await call('brp_read_log', { filename: '../secrets/bevy-mcp_x_1.log' });
  assert.equal(traversal.isError, true);
  assert.equal(envelope(traversal).status, 'error');
  assert.match(envelope(traversal).message, /only bevy-mcp log files can be read/);

  const absolute = await call('brp_read_log', { filename: '/etc/passwd' });
  assert.equal(absolute.isError, true);
  assert.match(envelope(absolute).message, /only bevy-mcp log files can be read/);

  const unknown = await call('brp_read_log', { filename: 'bevy-mcp_ghost_123.log' });
  assert.equal(unknown.isError, true);
  assert.match(envelope(unknown).message, /not found/);

  // Extra params are ignored, not rejected: a port or path next to a valid
  // filename still reads through the owned roots only.
  const filename = await seedAppLog(logStore, 'extra', ['one']);
  const withExtras = await call('brp_read_log', { filename, port: 9999, file_path: '/etc' });
  assert.equal(envelope(withExtras).status, 'success');
});

test('brp_delete_logs accepts only {app_name?, older_than_seconds?} and reports deletions', async () => {
  const { logStore, call } = harness();
  const gone = await seedAppLog(logStore, 'doomed', ['x']);
  const kept = await seedAppLog(logStore, 'survivor', ['y']);
  const watchLog = (await logStore.createWatchLog(7, 1, 'list')).filename;
  ageFile(await pathOf(logStore, 'doomed'), 60_000);

  const result = await call('brp_delete_logs', { app_name: 'doomed', older_than_seconds: 30 });
  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Deleted 1 log files');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_delete_logs' });
  assert.deepEqual(env.metadata, {
    deleted_files: [gone],
    deleted_count: 1,
    app_name_filter: 'doomed',
    older_than_seconds: 30,
  });

  const remaining = await logStore.list();
  assert.ok(remaining.some((log) => log.filename === kept));
  assert.ok(remaining.some((log) => log.filename === watchLog));

  // No filters deletes everything, watch logs included (upstream behavior).
  const all = envelope(await call('brp_delete_logs', {}));
  assert.equal(all.status, 'success');
  assert.equal((all.metadata as Record<string, unknown>).deleted_count, 2);
  assert.deepEqual(
    ((all.metadata as Record<string, unknown>).deleted_files as string[]).sort(),
    [kept, watchLog],
  );
  assert.equal((all.metadata as Record<string, unknown>).app_name_filter, undefined);
  assert.equal((all.metadata as Record<string, unknown>).older_than_seconds, undefined);
});

test('brp_delete_logs age filter keeps newer logs', async () => {
  const { logStore, call } = harness();
  const old = await seedAppLog(logStore, 'aged', ['old-line']);
  ageFile(await pathOf(logStore, 'aged'), 3_600_000);
  const fresh = await seedAppLog(logStore, 'aged', ['new-line']);

  const result = envelope(await call('brp_delete_logs', { older_than_seconds: 1_800 }));
  assert.deepEqual((result.metadata as Record<string, unknown>).deleted_files, [old]);
  assert.equal((result.metadata as Record<string, unknown>).older_than_seconds, 1_800);
  assert.equal((result.metadata as Record<string, unknown>).app_name_filter, undefined);

  const left = await logStore.list({ appName: 'aged' });
  assert.deepEqual(left.map((log) => log.filename), [fresh]);
});
