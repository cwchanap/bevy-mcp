import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { BrpCallOptions, BrpClient } from '../src/brp/client.js';
import { CargoRuntime } from '../src/runtime/cargo.js';
import type { BevyMcpServices } from '../src/services.js';
import { LogStore } from '../src/runtime/log-store.js';
import { ProcessManager } from '../src/runtime/process-manager.js';
import { WatchManager } from '../src/runtime/watch-manager.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';
import { registerWatchTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';

// Isolated LogStore root per test file (node:test runs files as processes).
const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-watch-tools-'));
test.after(async () => {
  rmSync(BASE, { recursive: true, force: true });
});

interface StreamCall {
  method: string;
  params: unknown;
  port?: number;
  signal?: AbortSignal;
}

/** BrpClient fake whose `stream()` returns a successful, silent SSE Response. */
class FakeWatchBrp {
  calls: StreamCall[] = [];

  async stream(method: string, params: unknown, options: BrpCallOptions = {}): Promise<Response> {
    this.calls.push({ method, params, port: options.port, signal: options.signal });
    const body = new ReadableStream<Uint8Array>({ start() {} }); // stays open
    return new Response(body, { status: 200 });
  }
}

function harness(): {
  brp: FakeWatchBrp;
  manager: WatchManager;
  logStore: LogStore;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const brp = new FakeWatchBrp();
  const logStore = new LogStore(join(BASE, `case-${Math.random().toString(36).slice(2)}`));
  const services: BevyMcpServices = {
    brp: brp as unknown as BrpClient,
    catalog: loadToolContractCatalog(),
    logStore,
    cargo: new CargoRuntime(),
    watches: new WatchManager(logStore, brp as unknown as BrpClient),
    processes: new ProcessManager(() => {
      throw new Error('no spawn expected in this test');
    }),
  };
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerWatchTools(server, services, loadToolContractCatalog());
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;
  return {
    brp,
    manager: services.watches,
    logStore,
    call: (name, args = {}) => tools[name]!.handler(args),
  };
}

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

test('registerWatchTools registers exactly the four watch tools', () => {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerWatchTools(
    server,
    {
      brp: {} as BrpClient,
      catalog: loadToolContractCatalog(),
      cargo: new CargoRuntime(),
      logStore: new LogStore(join(BASE, 'registry-only')),
      watches: new WatchManager(new LogStore(join(BASE, 'registry-only')), {} as BrpClient),
      processes: new ProcessManager(() => {
        throw new Error('no spawn expected in this test');
      }),
    },
    loadToolContractCatalog(),
  );
  assert.deepEqual(
    Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort(),
    ['brp_list_active_watches', 'brp_stop_watch', 'world_get_components_watch', 'world_list_components_watch'],
  );
});

test('world_get_components_watch starts a watch and returns id + log path', async () => {
  const { brp, manager, call } = harness();
  const result = await call('world_get_components_watch', {
    entity: 42,
    types: ['bevy_ecs::name::Name'],
  });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Started watch 1');
  assert.deepEqual(env.call_info, {
    mcp_tool: 'world_get_components_watch',
    brp_method: 'world.get_components+watch',
  });
  const metadata = env.metadata as { watch_id: number; log_path: string };
  assert.equal(metadata.watch_id, 1);
  assert.match(metadata.log_path, /bevy-mcp_watch_1_get_42_\d+\.log$/);
  assert.notEqual(result.isError, true);

  assert.deepEqual(brp.calls[0], {
    method: 'world.get_components+watch',
    params: { entity: 42, components: ['bevy_ecs::name::Name'] },
    port: 15702,
    signal: brp.calls[0]?.signal,
  });

  assert.deepEqual(
    manager.list().map((watch) => watch.watch_id),
    [1],
  );
  await manager.stopAll();
});

test('world_get_components_watch forwards a custom port and rejects empty types', async () => {
  const { brp, manager, call } = harness();
  const started = await call('world_get_components_watch', {
    entity: 7,
    types: ['A'],
    port: 15999,
  });
  assert.equal(envelope(started).status, 'success');
  assert.equal(brp.calls[0]?.port, 15999);

  const empty = await call('world_get_components_watch', { entity: 7, types: [] });
  const env = envelope(empty);
  assert.equal(env.status, 'error');
  assert.equal(empty.isError, true);
  assert.match(env.message, /cannot be empty/);
  assert.deepEqual(env.call_info, {
    mcp_tool: 'world_get_components_watch',
    brp_method: 'world.get_components+watch',
  });
  await manager.stopAll();
});

test('world_list_components_watch starts a list watch on the default port', async () => {
  const { brp, manager, call } = harness();
  const result = await call('world_list_components_watch', { entity: 9 });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Started watch 1');
  assert.deepEqual(env.call_info, {
    mcp_tool: 'world_list_components_watch',
    brp_method: 'world.list_components+watch',
  });
  const metadata = env.metadata as { watch_id: number; log_path: string };
  assert.match(metadata.log_path, /bevy-mcp_watch_1_list_9_\d+\.log$/);
  assert.equal(brp.calls[0]?.method, 'world.list_components+watch');
  assert.deepEqual(brp.calls[0]?.params, { entity: 9 });
  await manager.stopAll();
});

test('brp_list_active_watches reports the upstream-compatible watch shape', async () => {
  const { manager, call } = harness();
  const started = await call('world_list_components_watch', { entity: 9 });
  const startMetadata = envelope(started).metadata as { watch_id: number; log_path: string };
  const result = await call('brp_list_active_watches');

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Found 1 active watches');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_list_active_watches' });
  assert.deepEqual(env.metadata, { watch_count: 1 });
  // Upstream `#[to_result]` places the bare watch array in `result`.
  const watches = env.result as {
    watch_id: number;
    entity_id: number;
    watch_type: string;
    log_path: string;
    port: number;
  }[];
  assert.equal(watches.length, 1);
  const watch = watches[0]!;
  assert.equal(watch.watch_id, 1);
  assert.equal(watch.entity_id, 9);
  assert.equal(watch.watch_type, 'list');
  assert.equal(watch.port, 15702);
  assert.equal(watch.log_path, startMetadata.log_path);
  await manager.stopAll();
});

test('brp_stop_watch stops and reports; unknown ids are tool errors', async () => {
  const { manager, logStore, call } = harness();
  await call('world_get_components_watch', { entity: 3, types: ['A'] });

  const stopped = await call('brp_stop_watch', { watch_id: 1 });
  const env = envelope(stopped);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Stopped watch 1');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_stop_watch' });
  assert.deepEqual(env.metadata, { watch_id: 1 });
  assert.deepEqual(manager.list(), []);

  const unknown = await call('brp_stop_watch', { watch_id: 99 });
  const unknownEnv = envelope(unknown);
  assert.equal(unknownEnv.status, 'error');
  assert.equal(unknown.isError, true);
  // Upstream wraps the manager failure through its error stack, repeating the
  // text (verified against the 0.22.3 oracle).
  assert.equal(
    unknownEnv.message,
    'Failed to stop watch 99: Watch operation failed: Failed to stop watch 99: watch not found',
  );

  // The stopped watch's log file remains for analysis.
  const logs = await logStore.list();
  assert.equal(logs.length, 1);
  assert.match(logs[0]!.filename, /^bevy-mcp_watch_1_get_3_/);
});
