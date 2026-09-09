import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT, type BrpCallOptions, type BrpClient } from '../src/brp/client.js';
import { BrpError, BrpJsonRpcError } from '../src/brp/errors.js';
import { CargoRuntime } from '../src/runtime/cargo.js';
import type { BevyMcpServices } from '../src/services.js';
import { LogStore } from '../src/runtime/log-store.js';
import type { WatchManager } from '../src/runtime/watch-manager.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';
import { EXTRAS_DIRECT } from '../src/tools/extras.js';
import { registerExtrasTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';

/**
 * Fake BrpClient answering from a per-method response map. Records every call.
 * Per-method `errors` throw before responses are consulted.
 */
class FakeBrpClient {
  calls: { method: string; params: unknown; port?: number }[] = [];
  responses = new Map<string, unknown>();
  errors = new Map<string, BrpError>();

  async call(method: string, params?: unknown, options: BrpCallOptions = {}): Promise<unknown> {
    this.calls.push({ method, params, port: options.port });
    const error = this.errors.get(method);
    if (error) throw error;
    return this.responses.get(method) ?? { saved: true };
  }
}

function fakeServices(fake: FakeBrpClient): BevyMcpServices {
  return {
    brp: fake as unknown as BrpClient,
    catalog: loadToolContractCatalog(),
    logStore: new LogStore(`${tmpdir()}/bevy-mcp-test-unused`),
    cargo: new CargoRuntime(),
    watches: { stopAll: async () => {} } as unknown as WatchManager,
    processes: { shutdownAll: async () => {} },
  };
}

function registeredHandler(
  server: McpServer,
  name: string,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `tool not registered: ${name}`);
  return tool.handler;
}

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

function setup(): {
  fake: FakeBrpClient;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const fake = new FakeBrpClient();
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerExtrasTools(server, fakeServices(fake), loadToolContractCatalog());
  return {
    fake,
    call: (name, args = {}) => registeredHandler(server, name)(args),
  };
}

/** Canned `world.query` rows in the live Bevy 0.19 wire shape (unsorted). */
const QUERY_ROWS = [
  { entity: 4294967040, components: { 'bevy_ecs::name::Name': 'Other' } },
  { entity: 4294966880, components: { 'bevy_ecs::name::Name': 'NatesList' } },
  { entity: 4294967024, components: { 'bevy_ecs::name::Name': 'NatesListDup' } },
];

// --- The 13 direct passthrough tools ---

test('the fixed extras mappings cover exactly the 13 direct tools from the brief', () => {
  assert.equal(Object.keys(EXTRAS_DIRECT).length, 13);
  assert.deepEqual(Object.keys(EXTRAS_DIRECT).sort(), [
    'brp_extras_click_mouse',
    'brp_extras_double_click_mouse',
    'brp_extras_double_tap_gesture',
    'brp_extras_drag_mouse',
    'brp_extras_get_diagnostics',
    'brp_extras_move_mouse',
    'brp_extras_pinch_gesture',
    'brp_extras_rotation_gesture',
    'brp_extras_scroll_mouse',
    'brp_extras_send_keys',
    'brp_extras_send_mouse_button',
    'brp_extras_set_window_title',
    'brp_extras_type_text',
  ]);
});

test('registerExtrasTools registers exactly the 13 direct tools plus the screenshot composite', () => {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerExtrasTools(server, fakeServices(new FakeBrpClient()), loadToolContractCatalog());
  assert.deepEqual(
    Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort(),
    [...Object.keys(EXTRAS_DIRECT), 'brp_extras_screenshot'].sort(),
  );
});

test('every direct extras tool calls its fixed method with explicit port and correct envelope', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(EXTRAS_DIRECT)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerExtrasTools(server, fakeServices(fake), catalog);

    // Every extras input schema has at least one required non-port field.
    const contract = catalog.get(name);
    const required = contract.inputSchema.required ?? [];
    assert.ok(!required.includes('port'), `${name}: port is optional`);
    const args: Record<string, unknown> = { port: 7777 };
    for (const key of required) args[key] = 'sample';

    fake.responses.set(method, { saved: true });
    const result = await registeredHandler(server, name)(args);

    assert.equal(fake.calls.length, 1, `${name}: exactly one BRP call`);
    const call = fake.calls[0]!;
    assert.equal(call.method, method, `${name}: fixed BRP method`);
    assert.equal(call.port, 7777, `${name}: explicit port routing`);

    const { port: _port, ...expectedParams } = args;
    const forwarded = Object.keys(expectedParams).length > 0 ? expectedParams : undefined;
    assert.deepEqual(call.params, forwarded, `${name}: forwarded params exclude port`);

    const env = envelope(result);
    assert.equal(env.status, 'success', `${name}: success status`);
    assert.deepEqual(env.call_info, { mcp_tool: name, brp_method: method }, `${name}: call_info`);
    assert.deepEqual(env.result, { saved: true }, `${name}: BRP result placement`);
    assert.notEqual(result.isError, true, `${name}: no isError`);
  }
});

test('every direct extras tool defaults the port to DEFAULT_BRP_PORT when absent', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(EXTRAS_DIRECT)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerExtrasTools(server, fakeServices(fake), catalog);
    await registeredHandler(server, name)({});
    assert.equal(fake.calls[0]!.port, DEFAULT_BRP_PORT, `${name}: default port`);
    assert.equal(fake.calls[0]!.method, method, `${name}: fixed method on default-port call`);
  }
});

test('every direct extras tool converts BRP errors into an error envelope with error_info', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(EXTRAS_DIRECT)) {
    const fake = new FakeBrpClient();
    fake.errors.set(method, new BrpJsonRpcError(method, -32602, 'invalid params'));
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerExtrasTools(server, fakeServices(fake), catalog);
    const result = await registeredHandler(server, name)({});

    const env = envelope(result);
    assert.equal(env.status, 'error', `${name}: error status`);
    assert.equal(result.isError, true, `${name}: isError set`);
    assert.deepEqual(env.call_info, { mcp_tool: name, brp_method: method }, `${name}: call_info`);
    assert.deepEqual(env.error_info, {
      code: -32602,
      message: fake.errors.get(method)!.message,
    });
    assert.equal('result' in env, false, `${name}: no result on error`);
  }
});

// --- The brp_extras_screenshot composite ---

test('full-window mode forwards only path on the default port', async () => {
  const { fake, call } = setup();
  const result = await call('brp_extras_screenshot', { path: '/tmp/full.png' });

  assert.deepEqual(fake.calls, [
    { method: 'brp_extras/screenshot', params: { path: '/tmp/full.png' }, port: DEFAULT_BRP_PORT },
  ]);
  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_extras_screenshot' });
  assert.notEqual(result.isError, true);
});

test('camera-only mode captures the viewport', async () => {
  const { fake, call } = setup();
  await call('brp_extras_screenshot', { camera: 4294967297, path: '/tmp/camera.png', port: 7777 });

  assert.deepEqual(fake.calls, [
    {
      method: 'brp_extras/screenshot',
      params: { camera: 4294967297, path: '/tmp/camera.png' },
      port: 7777,
    },
  ]);
});

test('entity mode forwards the canonical entity ID', async () => {
  const { fake, call } = setup();
  await call('brp_extras_screenshot', {
    entity: 4294967298,
    camera: 4294967297,
    padding: 16,
    path: '/tmp/entity.png',
  });

  assert.deepEqual(fake.calls[0]!.params, {
    entity: 4294967298,
    camera: 4294967297,
    padding: 16,
    path: '/tmp/entity.png',
  });
});

test('exact-name mode resolves one unique match and sends only the resolved entity ID', async () => {
  const { fake, call } = setup();
  fake.responses.set('world.query', QUERY_ROWS);
  const result = await call('brp_extras_screenshot', {
    name: 'NatesList',
    camera: 4294967297,
    padding: 8,
    path: '/tmp/nates-list.png',
    port: 7777,
  });

  assert.deepEqual(
    fake.calls.map((entry) => entry.method),
    ['world.query', 'brp_extras/screenshot'],
    'name lookup runs through the shared world.query path',
  );
  assert.deepEqual(fake.calls[0]!.port, 7777, 'lookup routes on the caller port');
  assert.deepEqual(fake.calls[0]!.params, {
    data: { components: ['bevy_ecs::name::Name'] },
    filter: { with: ['bevy_ecs::name::Name'] },
  });
  assert.deepEqual(
    fake.calls[1]!.params,
    { entity: 4294966880, camera: 4294967297, padding: 8, path: '/tmp/nates-list.png' },
    'resolved entity replaces the name; camera/padding stay canonical',
  );
  assert.equal(fake.calls[1]!.port, 7777);
  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_extras_screenshot' });
});

test('entity and name together are rejected without any BRP call', async () => {
  const { fake, call } = setup();
  const result = await call('brp_extras_screenshot', {
    entity: 4294967298,
    name: 'NatesList',
    path: '/tmp/x.png',
  });
  assert.equal(fake.calls.length, 0);
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /either entity or name, never both/);
});

test('padding without an entity or name selector is rejected', async () => {
  const { fake, call } = setup();
  for (const args of [
    { padding: 10, path: '/tmp/x.png' },
    { padding: 10, camera: 4294967297, path: '/tmp/x.png' },
  ]) {
    const result = await call('brp_extras_screenshot', args);
    assert.equal(fake.calls.length, 0, JSON.stringify(args));
    const env = envelope(result);
    assert.equal(env.status, 'error');
    assert.equal(result.isError, true);
    assert.match(env.message, /padding requires an entity or name selector/);
  }
});

test('zero name matches reject before any screenshot call', async () => {
  const { fake, call } = setup();
  fake.responses.set('world.query', QUERY_ROWS);
  const result = await call('brp_extras_screenshot', {
    name: 'Missing',
    path: '/tmp/x.png',
  });

  assert.deepEqual(
    fake.calls.map((entry) => entry.method),
    ['world.query'],
    'only the lookup runs',
  );
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /No entity named 'Missing' was found/);
});

test('duplicate exact names reject with the candidate entity IDs', async () => {
  const { fake, call } = setup();
  fake.responses.set('world.query', [
    ...QUERY_ROWS,
    { entity: 4294966881, components: { 'bevy_ecs::name::Name': 'NatesList' } },
  ]);
  const result = await call('brp_extras_screenshot', {
    name: 'NatesList',
    path: '/tmp/x.png',
  });

  assert.deepEqual(
    fake.calls.map((entry) => entry.method),
    ['world.query'],
    'only the lookup runs',
  );
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /matched 2 entities \(4294966880, 4294966881\)/);
});

test('name-mode lookup failures surface as an Internal error envelope', async () => {
  const { fake, call } = setup();
  fake.errors.set('world.query', new BrpJsonRpcError('world.query', -32602, 'invalid params'));
  const result = await call('brp_extras_screenshot', { name: 'NatesList', path: '/tmp/x.png' });

  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /^Internal error: /);
  assert.equal('result' in env, false);
});

test('screenshot BRP failures produce an error envelope with error_info', async () => {
  const { fake, call } = setup();
  fake.errors.set('brp_extras/screenshot', new BrpJsonRpcError('brp_extras/screenshot', -1, 'no camera'));
  const result = await call('brp_extras_screenshot', { entity: 4294967298, path: '/tmp/x.png' });

  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /no camera/);
  assert.deepEqual(env.error_info, {
    code: -1,
    message: fake.errors.get('brp_extras/screenshot')!.message,
  });
});
