import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT, type BrpCallOptions, type BrpClient } from '../src/brp/client.js';
import { BrpError, BrpJsonRpcError, BrpPrecisionError } from '../src/brp/errors.js';
import { CargoRuntime } from '../src/runtime/cargo.js';
import type { BevyMcpServices } from '../src/services.js';
import { LogStore } from '../src/runtime/log-store.js';
import { ProcessManager } from '../src/runtime/process-manager.js';
import type { WatchManager } from '../src/runtime/watch-manager.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';
import { registerDiscoveryTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';

/**
 * Fake BrpClient answering from a per-method response map (the `discover`
 * convenience call routes through `rpc.discover`). Records every call.
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
    if (!this.responses.has(method)) throw new Error(`unexpected BRP call: ${method}`);
    return this.responses.get(method);
  }

  async discover(port?: number): Promise<unknown> {
    return this.call('rpc.discover', undefined, { port });
  }
}

function fakeServices(fake: FakeBrpClient): BevyMcpServices {
  return {
    brp: fake as unknown as BrpClient,
    catalog: loadToolContractCatalog(),
    logStore: new LogStore(`${tmpdir()}/bevy-mcp-test-unused`),
    cargo: new CargoRuntime(),
    watches: { stopAll: async () => {} } as unknown as WatchManager,
    processes: new ProcessManager(() => {
      throw new Error('no spawn expected in this test');
    }),
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

/** Canned `world.query` rows in the live Bevy 0.19 wire shape (unsorted). */
const QUERY_ROWS = [
  { entity: 4294967024, components: { 'bevy_ecs::name::Name': 'LineGizmoRenderer' } },
  { entity: 4294966880, components: { 'bevy_ecs::name::Name': 'FixturePrimary' } },
  { entity: 4294967023, components: { 'bevy_ecs::name::Name': 'LineStripGizmoRenderer' } },
  { entity: 4294967022, components: { 'bevy_ecs::name::Name': 'LineJointGizmoRenderer' } },
];

function setup(
  responses: Record<string, unknown> = {},
): {
  fake: FakeBrpClient;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const fake = new FakeBrpClient();
  for (const [method, response] of Object.entries(responses)) {
    fake.responses.set(method, response);
  }
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDiscoveryTools(server, fakeServices(fake), loadToolContractCatalog());
  return {
    fake,
    call: (name, args = {}) => registeredHandler(server, name)(args),
  };
}

const FIND = 'world_find_entities_by_name';

/** Minimal VALID rpc.discover document — upstream's typed OpenRpcDocument
 * decode (bevy_remote 0.19.1) requires `openrpc`, `info.title`/`info.version`,
 * and `methods`, and type-checks `params`/`servers` when present. */
const discoverDoc = (methods: unknown[]): Record<string, unknown> => ({
  openrpc: '1.3.2',
  info: { title: 'Bevy Remote Protocol', version: '0.19.1' },
  methods,
});

/** A well-formed MethodObject param (`Parameter`: name + JsonSchemaBevyType
 * `schema` with required shortPath/typePath/kind/type). */
const VALID_PARAM = {
  name: 'entity',
  schema: {
    shortPath: 'Entity',
    typePath: 'bevy_ecs::entity::Entity',
    kind: 'Value',
    type: 'uint',
  },
};

test('registerDiscoveryTools registers exactly the three composite tools', () => {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDiscoveryTools(server, fakeServices(new FakeBrpClient()), loadToolContractCatalog());
  assert.deepEqual(
    Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort(),
    ['brp_execute', 'brp_list_agent_tools', 'world_find_entities_by_name'],
  );
});

test('find-by-name issues ONE world.query with the Name path in data and filter', async () => {
  const { call } = setup({ 'world.query': QUERY_ROWS });
  const result = await call(FIND, { name: 'FixturePrimary' });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.deepEqual(env.call_info, { mcp_tool: 'world_find_entities_by_name' });
  assert.equal(env.message, 'Found 1 named entities');
  assert.deepEqual(env.metadata, { entity_count: 1 });
  assert.deepEqual(env.result, [{ entity: 4294966880, name: 'FixturePrimary' }]);
  assert.notEqual(result.isError, true);
});

test('find-by-name sends exactly one query with the reflected path on default port', async () => {
  const { fake, call } = setup({ 'world.query': QUERY_ROWS });
  await call(FIND, { name: 'FixturePrimary' });

  assert.equal(fake.calls.length, 1, 'exactly one BRP call');
  assert.deepEqual(fake.calls[0], {
    method: 'world.query',
    params: {
      data: { components: ['bevy_ecs::name::Name'] },
      filter: { with: ['bevy_ecs::name::Name'] },
    },
    port: DEFAULT_BRP_PORT,
  });
});

test('find-by-name supports every match mode', async () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ name: 'LineGizmoRenderer' }, ['LineGizmoRenderer']],
    [
      { name: 'Line', match_mode: 'prefix' },
      ['LineJointGizmoRenderer', 'LineStripGizmoRenderer', 'LineGizmoRenderer'],
    ],
    [
      { name: 'GizmoRenderer', match_mode: 'suffix' },
      ['LineJointGizmoRenderer', 'LineStripGizmoRenderer', 'LineGizmoRenderer'],
    ],
    [
      { name: 'Gizmo', match_mode: 'contains' },
      ['LineJointGizmoRenderer', 'LineStripGizmoRenderer', 'LineGizmoRenderer'],
    ],
  ];
  for (const [args, expectedNames] of cases) {
    const { call } = setup({ 'world.query': QUERY_ROWS });
    const env = envelope(await call(FIND, args));
    assert.equal(env.status, 'success', JSON.stringify(args));
    assert.deepEqual(
      (env.result as { name: string }[]).map((entry) => entry.name),
      expectedNames,
      JSON.stringify(args),
    );
    assert.deepEqual(env.metadata, { entity_count: expectedNames.length });
  }
});

test('find-by-name is case-sensitive and treats * as a literal', async () => {
  for (const args of [
    { name: 'fixtureprimary' },
    { name: 'Fix*', exact: true },
  ] as Record<string, unknown>[]) {
    const { call } = setup({ 'world.query': QUERY_ROWS });
    const env = envelope(await call(FIND, args));
    assert.equal(env.status, 'success', JSON.stringify(args));
    assert.deepEqual(env.result, [], `expected no matches for ${JSON.stringify(args)}`);
    assert.equal(env.message, 'Found 0 named entities');
    assert.deepEqual(env.metadata, { entity_count: 0 });
  }
});

test('find-by-name sorts results by entity ID and returns only entity+name', async () => {
  const { call } = setup({ 'world.query': QUERY_ROWS });
  const env = envelope(await call(FIND, { name: 'Line', match_mode: 'prefix' }));
  assert.deepEqual(env.result, [
    { entity: 4294967022, name: 'LineJointGizmoRenderer' },
    { entity: 4294967023, name: 'LineStripGizmoRenderer' },
    { entity: 4294967024, name: 'LineGizmoRenderer' },
  ]);
});

test('find-by-name skips rows without a decodable string Name', async () => {
  const { call } = setup({
    'world.query': [
      { entity: 7, components: { 'bevy_ecs::name::Name': 'Real' } },
      { entity: 8, components: { 'bevy_ecs::name::Name': 42 } },
      { entity: 9 },
      { components: { 'bevy_ecs::name::Name': 'NoEntity' } },
    ],
  });
  const env = envelope(await call(FIND, { name: 'Real' }));
  assert.deepEqual(env.result, [{ entity: 7, name: 'Real' }]);
});

test('find-by-name routes an explicit port', async () => {
  const { fake, call } = setup({ 'world.query': QUERY_ROWS });
  await call(FIND, { name: 'FixturePrimary', port: 7777 });
  assert.equal(fake.calls[0]!.port, 7777);
});

test('find-by-name surfaces unsafe entity ids as an error envelope', async () => {
  const fake = new FakeBrpClient();
  fake.errors.set(
    'world.query',
    new BrpPrecisionError('world.query', 'result[0].entity', 1.8446744073709552e19),
  );
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDiscoveryTools(server, fakeServices(fake), loadToolContractCatalog());
  const result = await registeredHandler(server, FIND)({ name: 'x' });
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /^Internal error: .*unsafe integer/);
  assert.equal('result' in env, false);
});

test('find-by-name rejects an unknown match_mode with an error envelope', async () => {
  const { fake, call } = setup({ 'world.query': QUERY_ROWS });
  const result = await call(FIND, { name: 'FixturePrimary', match_mode: 'regex' });
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /Invalid match_mode 'regex'/);
  assert.equal(fake.calls.length, 0, 'invalid mode must not reach BRP');
});

test('find-by-name converts BRP failures into an Internal error envelope', async () => {
  const fake = new FakeBrpClient();
  fake.errors.set('world.query', new BrpJsonRpcError('world.query', -32602, 'invalid params'));
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDiscoveryTools(server, fakeServices(fake), loadToolContractCatalog());
  const result = await registeredHandler(server, FIND)({ name: 'x' });
  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.match(env.message, /^Internal error: /);
});

test('brp_execute validates discovery then passes the method through', async () => {
  const { fake, call } = setup();
  fake.responses.set(
    'rpc.discover',
    discoverDoc([{ name: 'world.query', params: [] }, { name: 'bevy_mcp/world_stats', params: [VALID_PARAM] }]),
  );
  fake.responses.set('bevy_mcp/world_stats', { returned: 1, truncated: true });
  const result = await call('brp_execute', {
    method: 'bevy_mcp/world_stats',
    params: { limit: 1 },
    port: 7777,
  });

  assert.deepEqual(
    fake.calls.map((entry) => entry.method),
    ['rpc.discover', 'bevy_mcp/world_stats'],
    'discover must run before the invocation',
  );
  assert.deepEqual(fake.calls[1]!.params, { limit: 1 });
  assert.equal(fake.calls[1]!.port, 7777);

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_execute' });
  assert.equal(env.message, 'Executed method bevy_mcp/world_stats');
  assert.deepEqual(env.result, { returned: 1, truncated: true });
});

test('brp_execute rejects a method missing from discovery with available methods', async () => {
  const { fake, call } = setup();
  fake.responses.set(
    'rpc.discover',
    discoverDoc([{ name: 'world.query' }, { name: 'bevy_mcp/world_stats' }]),
  );
  const result = await call('brp_execute', { method: 'no/such/method' });
  const env = envelope(result);

  assert.equal(fake.calls.length, 1, 'missing method must not be invoked');
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.equal(env.message, 'BRP method `no/such/method` is not registered on port 15702');
  assert.deepEqual(env.metadata, {
    stage: 'discovery',
    method: 'no/such/method',
    port: DEFAULT_BRP_PORT,
    available_methods: ['bevy_mcp/world_stats', 'world.query'],
  });
  assert.equal('result' in env, false);
});

test('brp_execute rejects malformed rpc.discover documents as decode failures', async () => {
  const fullDoc = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...discoverDoc([{ name: 'world.query' }]),
    ...overrides,
  });
  for (const document of [
    { methods: 'invalid' },
    { methods: [{ name: 'world.query' }, 'bogus-entry'] },
    { methods: [{ name: 'world.query' }, { name: 7 }] },
    { methods: [{ name: 'world.query' }, { params: [] }] },
    'raw-string',
    null,
    // Upstream's typed OpenRpcDocument decode requires openrpc/info/methods —
    // each missing-or-misshaped field is a decode failure, not an empty list.
    { openrpc: '1.3.2', methods: [{ name: 'world.query' }] }, // no info
    { info: { title: 't', version: 'v' }, methods: [{ name: 'world.query' }] }, // no openrpc
    fullDoc({ openrpc: 7 }),
    fullDoc({ info: { version: '0.19.1' } }), // no title
    fullDoc({ info: { title: 't' } }), // no version
    fullDoc({ info: { title: 't', version: 'v', description: 42 } }),
    fullDoc({ methods: null }),
    // Method payloads are part of the typed decode when present.
    discoverDoc([{ name: 'world.query', params: 'bogus' }]),
    discoverDoc([{ name: 'world.query', params: null }]),
    discoverDoc([{ name: 'world.query', params: [{}] }]), // no name/schema
    discoverDoc([{ name: 'world.query', params: [{ name: 'p' }] }]), // no schema
    discoverDoc([{ name: 'world.query', params: [{ name: 'p', schema: {} }] }]),
    discoverDoc([
      {
        name: 'world.query',
        params: [
          { name: 'p', schema: { shortPath: 'P', typePath: 'p::P', kind: 'Bogus', type: 'uint' } },
        ],
      },
    ]),
    discoverDoc([{ name: 'world.query', summary: 42 }]),
    fullDoc({ servers: 'bogus' }),
    fullDoc({ servers: [{ name: 's' }] }), // no url
  ]) {
    const { fake, call } = setup();
    fake.responses.set('rpc.discover', document);
    const result = await call('brp_execute', { method: 'world.query' });
    const env = envelope(result);

    assert.equal(env.status, 'error', JSON.stringify(document));
    assert.equal(result.isError, true);
    assert.equal(env.message, 'Unable to decode rpc.discover response from port 15702');
    assert.equal((env.metadata as Record<string, unknown>).stage, 'discovery');
    assert.equal((env.metadata as Record<string, unknown>).port, DEFAULT_BRP_PORT);
    assert.equal(fake.calls.length, 1, 'decode failure must not invoke the method');
  }
});

test('brp_execute rejects empty method names in the discover document', async () => {
  const { fake, call } = setup();
  fake.responses.set(
    'rpc.discover',
    discoverDoc([{ name: 'world.query' }, { name: '' }]),
  );
  const env = envelope(await call('brp_execute', { method: 'world.query' }));

  assert.equal(env.status, 'error');
  assert.equal(env.message, 'Unable to decode rpc.discover response from port 15702');
  assert.match(String((env.metadata as Record<string, unknown>).error), /empty method name/);
  assert.equal(fake.calls.length, 1);
});

test('brp_execute reports discovery transport failures with stage metadata', async () => {
  const { fake, call } = setup();
  fake.errors.set('rpc.discover', new BrpError('BRP endpoint unreachable'));
  const result = await call('brp_execute', { method: 'world.query', port: 15999 });
  const env = envelope(result);

  assert.equal(env.status, 'error');
  assert.equal(env.message, 'Failed to discover BRP methods on port 15999');
  assert.deepEqual(env.metadata, {
    stage: 'discovery',
    port: 15999,
    error: 'BRP endpoint unreachable',
  });
});

test('brp_execute reports BRP invocation failures with execution metadata', async () => {
  const { fake, call } = setup();
  fake.responses.set('rpc.discover', discoverDoc([{ name: 'world.get_components' }]));
  fake.errors.set(
    'world.get_components',
    new BrpJsonRpcError('world.get_components', -32602, 'bad entity', { detail: 'x' }),
  );
  const result = await call('brp_execute', { method: 'world.get_components' });
  const env = envelope(result);

  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.equal(env.message, 'bad entity');
  assert.deepEqual(env.metadata, {
    stage: 'execution',
    method: 'world.get_components',
    port: 15702,
    code: -32602,
    data: { detail: 'x' },
  });
});

test('brp_execute wraps execution-stage transport failures in the error envelope', async () => {
  const { fake, call } = setup();
  fake.responses.set('rpc.discover', discoverDoc([{ name: 'world.get_components' }]));
  fake.errors.set('world.get_components', new BrpError('connect ECONNREFUSED 127.0.0.1:15702'));
  const result = await call('brp_execute', { method: 'world.get_components' });
  const env = envelope(result);

  // No raw rethrow: the standard error envelope with error_info, like every
  // other failure path.
  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.equal(env.message, 'connect ECONNREFUSED 127.0.0.1:15702');
  assert.deepEqual(env.metadata, {
    stage: 'execution',
    method: 'world.get_components',
    port: 15702,
  });
  assert.deepEqual(env.error_info, { message: 'connect ECONNREFUSED 127.0.0.1:15702' });
});

test('brp_execute omits params on the wire when the caller passes none', async () => {
  const { fake, call } = setup();
  fake.responses.set('rpc.discover', discoverDoc([{ name: 'rpc.discover' }]));
  const result = await call('brp_execute', { method: 'rpc.discover' });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1]!.params, undefined);
  assert.equal(envelope(result).status, 'success');
});

test('brp_list_agent_tools preserves the catalog result and reports the count', async () => {
  const { fake, call } = setup();
  const catalog = {
    version: 1,
    tools: [
      { name: 'bevy_mcp_time_control', method: 'bevy_mcp/time_control' },
      { name: 'bevy_mcp_world_stats', method: 'bevy_mcp/world_stats' },
    ],
  };
  fake.responses.set('brp_extras/agent_tools', catalog);
  const result = await call('brp_list_agent_tools', { port: 7777 });

  assert.deepEqual(fake.calls, [
    { method: 'brp_extras/agent_tools', params: undefined, port: 7777 },
  ]);
  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_list_agent_tools' });
  assert.equal(env.message, 'Listed 2 agent tools');
  assert.deepEqual(env.metadata, { tool_count: 2 });
  // The wire `version` envelope is dropped; the public payload is exactly
  // `{usage, tools}`.
  assert.deepEqual(env.result, {
    usage: "Pass an entry's method and matching params to brp_execute.",
    tools: catalog.tools,
  });
});

test('brp_list_agent_tools carries catalog request method, port, and code on errors', async () => {
  const { fake, call } = setup();
  const error = new BrpJsonRpcError('brp_extras/agent_tools', -32601, 'method not found');
  fake.errors.set('brp_extras/agent_tools', error);
  const result = await call('brp_list_agent_tools', {});
  const env = envelope(result);

  assert.equal(env.status, 'error');
  assert.equal(result.isError, true);
  assert.equal(env.message, 'Unable to fetch the agent tool catalog from port 15702');
  assert.deepEqual(env.metadata, {
    stage: 'catalog_fetch',
    method: 'brp_extras/agent_tools',
    port: DEFAULT_BRP_PORT,
    error: error.message,
    code: -32601,
  });
});
