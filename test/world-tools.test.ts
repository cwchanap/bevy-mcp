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
import { loadToolContractCatalog, type ToolContractCatalog } from '../src/tool-contracts.js';
import { registerDirectTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';
import { RESOURCE_DIRECT } from '../src/tools/resources.js';
import { WORLD_DIRECT } from '../src/tools/world.js';

const DIRECT_TOOLS: Record<string, string> = { ...WORLD_DIRECT, ...RESOURCE_DIRECT };

/** Records every call; answers from `response` or throws `error`. */
class FakeBrpClient {
  calls: { method: string; params: unknown; port?: number }[] = [];
  response: unknown = { fake: 'result' };
  error: BrpError | null = null;

  async call(method: string, params?: unknown, options: BrpCallOptions = {}): Promise<unknown> {
    this.calls.push({ method, params, port: options.port });
    if (this.error) throw this.error;
    return this.response;
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

// The SDK keeps registered tools (with their handlers) in this compile-time
// private record; tests invoke the handler directly.
function registeredHandler(server: McpServer, name: string): (args: Record<string, unknown>) => Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `tool not registered: ${name}`);
  return tool.handler;
}

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

/** Minimal schema-plausible values for every required input field. */
function requiredArgs(catalog: ToolContractCatalog, name: string): Record<string, unknown> {
  const contract = catalog.get(name);
  const properties = (contract.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const args: Record<string, unknown> = {};
  for (const key of contract.inputSchema.required ?? []) {
    const type = properties[key]?.type;
    if (type === 'array') args[key] = ['sample::Type'];
    else if (type === 'object') args[key] = { sample: {} };
    else if (type === 'number') args[key] = 42;
    else args[key] = 'sample::Type';
  }
  return args;
}

/** Optional input keys, in captured schema property order. */
function optionalKeys(catalog: ToolContractCatalog, name: string): string[] {
  const contract = catalog.get(name);
  const properties = Object.keys((contract.inputSchema.properties ?? {}) as object);
  const required = new Set(contract.inputSchema.required ?? []);
  return properties.filter((key) => !required.has(key));
}

test('the fixed mappings cover exactly the 17 direct tools from the brief', () => {
  assert.equal(Object.keys(WORLD_DIRECT).length, 12);
  assert.equal(Object.keys(RESOURCE_DIRECT).length, 5);
  assert.deepEqual(Object.keys(DIRECT_TOOLS).sort(), [
    'registry_schema',
    'rpc_discover',
    'world_despawn_entity',
    'world_get_components',
    'world_get_resources',
    'world_insert_components',
    'world_insert_resources',
    'world_list_components',
    'world_list_resources',
    'world_mutate_components',
    'world_mutate_resources',
    'world_query',
    'world_remove_components',
    'world_remove_resources',
    'world_reparent_entities',
    'world_spawn_entity',
    'world_trigger_event',
  ]);
});

test('every direct tool registers under its contract name', () => {
  const catalog = loadToolContractCatalog();
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDirectTools(server, fakeServices(new FakeBrpClient()), catalog);
  const registered = Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  );
  assert.deepEqual(registered.sort(), Object.keys(DIRECT_TOOLS).sort());
});

test('every direct tool calls its fixed method with explicit port and correct envelope', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    const args = { ...requiredArgs(catalog, name), port: 7777 };
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
    assert.deepEqual(env.result, fake.response, `${name}: BRP result placement`);
    assert.deepEqual(env.parameters, args, `${name}: parameters echo`);
    assert.notEqual(result.isError, true, `${name}: no isError`);
  }
});

test('every direct tool defaults the port to DEFAULT_BRP_PORT when absent', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    await registeredHandler(server, name)(requiredArgs(catalog, name));
    assert.equal(fake.calls[0]!.port, DEFAULT_BRP_PORT, `${name}: default port`);
    assert.equal(fake.calls[0]!.method, method, `${name}: fixed method on default-port call`);
  }
});

test('every direct tool normalizes null optionals in response parameters', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    const omitted = optionalKeys(catalog, name);
    assert.ok(omitted.length > 0, `${name}: has at least one optional (port)`);
    const args: Record<string, unknown> = {
      ...requiredArgs(catalog, name),
      ...Object.fromEntries(omitted.map((key) => [key, null])),
    };
    const result = await registeredHandler(server, name)(args);

    // Null port routes to the default port and is materialized in parameters
    // (like upstream's serde default), so it is not reported as not-provided.
    assert.equal(fake.calls[0]!.port, DEFAULT_BRP_PORT, `${name}: null port -> default`);
    const notProvided = omitted.filter((key) => key !== 'port');
    const expectedParameters: Record<string, unknown> = {
      ...requiredArgs(catalog, name),
      port: DEFAULT_BRP_PORT,
    };
    if (notProvided.length > 0) expectedParameters.optional_parameters_not_provided = notProvided;
    assert.deepEqual(envelope(result).parameters, expectedParameters, `${name}: normalized parameters`);

    // Forwarded BRP params keep the raw remaining fields (minus port).
    const { port: _port, ...raw } = args;
    assert.deepEqual(fake.calls[0]!.params, Object.keys(raw).length > 0 ? raw : undefined, `${name}: raw forwarded params`);
  }
});

test('every direct tool converts BRP errors into an error envelope with error_info', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    fake.error = new BrpJsonRpcError(method, -32602, 'invalid params', { detail: 'x' });
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    const result = await registeredHandler(server, name)({ ...requiredArgs(catalog, name), port: 7777 });

    const env = envelope(result);
    assert.equal(env.status, 'error', `${name}: error status`);
    assert.equal(result.isError, true, `${name}: isError set`);
    assert.deepEqual(env.call_info, { mcp_tool: name, brp_method: method }, `${name}: call_info`);
    assert.deepEqual(
      env.error_info,
      { code: -32602, message: fake.error.message, data: { detail: 'x' } },
      `${name}: error_info`,
    );
    assert.equal('result' in env, false, `${name}: no result on error`);
  }
});

test('unexpected non-BRP errors propagate instead of being swallowed', async () => {
  const catalog = loadToolContractCatalog();
  const fake = new FakeBrpClient();
  fake.error = new TypeError('boom') as unknown as BrpError;
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDirectTools(server, fakeServices(fake), catalog);
  await assert.rejects(
    registeredHandler(server, 'rpc_discover')({ port: 7777 }),
    /boom/,
  );
});
