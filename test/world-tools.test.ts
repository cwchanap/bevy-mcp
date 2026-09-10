import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT, type BrpCallOptions, type BrpClient } from '../src/brp/client.js';
import { BrpError, BrpJsonRpcError } from '../src/brp/errors.js';
import { CargoRuntime } from '../src/runtime/cargo.js';
import type { BevyMcpServices } from '../src/services.js';
import { LogStore } from '../src/runtime/log-store.js';
import { ProcessManager } from '../src/runtime/process-manager.js';
import type { WatchManager } from '../src/runtime/watch-manager.js';
import { loadToolContractCatalog, type ToolContractCatalog } from '../src/tool-contracts.js';
import { registerDirectTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';
import { RESOURCE_DIRECT } from '../src/tools/resources.js';
import { WORLD_DIRECT } from '../src/tools/world.js';

const DIRECT_TOOLS: Record<string, string> = { ...WORLD_DIRECT, ...RESOURCE_DIRECT };

/** Records every call; answers from `response` or throws `error` once. */
class FakeBrpClient {
  calls: { method: string; params: unknown; port?: number }[] = [];
  response: unknown = { fake: 'result' };
  error: BrpError | null = null;

  async call(method: string, params?: unknown, options: BrpCallOptions = {}): Promise<unknown> {
    this.calls.push({ method, params, port: options.port });
    if (this.error) {
      const error = this.error;
      this.error = null; // one-shot: guide-fetch fallbacks hit `response`
      throw error;
    }
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
    processes: new ProcessManager(() => {
      throw new Error('no spawn expected in this test');
    }),
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
    // The direct-family echo passes through provided fields plus the
    // materialized port (world_mutate_components without `path` loses the
    // echo entirely, matching the oracle).
    if (name === 'world_mutate_components') {
      assert.equal(env.parameters, undefined, `${name}: no echo without path`);
    } else {
      const parameters = env.parameters as Record<string, unknown>;
      for (const [key, value] of Object.entries(args)) {
        assert.deepEqual(parameters[key], value, `${name}: echo ${key}`);
      }
      assert.equal(parameters.port, 7777, `${name}: port echoed`);
    }
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

test('every direct tool echoes provided params and drops absent optionals silently', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    const omitted = optionalKeys(catalog, name).filter(
      (key) => !(name === 'world_mutate_components' && key === 'path'),
    );
    assert.ok(omitted.length > 0, `${name}: has at least one optional (port)`);
    const args: Record<string, unknown> = {
      ...requiredArgs(catalog, name),
      ...Object.fromEntries(omitted.map((key) => [key, null])),
    };
    const result = await registeredHandler(server, name)(args);

    // Null port routes to the default port; the direct-family echo passes
    // through provided (non-null) fields, materializes the port, and drops
    // absent/null optionals silently — NO omitted list (oracle parity).
    assert.equal(fake.calls[0]!.port, DEFAULT_BRP_PORT, `${name}: null port -> default`);
    const expectedParameters: Record<string, unknown> = { port: DEFAULT_BRP_PORT };
    for (const [key, value] of Object.entries(requiredArgs(catalog, name))) {
      expectedParameters[key] = value;
    }
    if (name === 'world_query') {
      const data = expectedParameters.data as Record<string, unknown>;
      data['option'] = [];
      data['has'] = [];
    }
    if (name !== 'world_mutate_components') {
      assert.deepEqual(envelope(result).parameters, expectedParameters, `${name}: direct echo`);
    } else {
      assert.equal(envelope(result).parameters, undefined, `${name}: no echo without path`);
    }

    // Forwarded BRP params keep the raw remaining fields (minus port).
    const { port: _port, ...raw } = args;
    assert.deepEqual(fake.calls[0]!.params, Object.keys(raw).length > 0 ? raw : undefined, `${name}: raw forwarded params`);
  }
});

test('every direct tool converts BRP errors into plain upstream error envelopes', async () => {
  const catalog = loadToolContractCatalog();
  for (const [name, method] of Object.entries(DIRECT_TOOLS)) {
    const fake = new FakeBrpClient();
    // A non-format-class code keeps every tool on the plain-error path.
    fake.error = new BrpJsonRpcError(method, -23403, 'invalid params', { detail: 'x' });
    const server = new McpServer({ name: 't', version: '0.0.0' });
    registerDirectTools(server, fakeServices(fake), catalog);
    const result = await registeredHandler(server, name)({ ...requiredArgs(catalog, name), port: 7777 });

    const env = envelope(result);
    assert.equal(env.status, 'error', `${name}: error status`);
    assert.equal(result.isError, true, `${name}: isError set`);
    assert.deepEqual(env.call_info, { mcp_tool: name, brp_method: method }, `${name}: call_info`);
    // Upstream appends the " (error code)" suffix and adds no other fields.
    assert.equal(env.message, 'invalid params (error -23403)', `${name}: enhanced message`);
    assert.equal('error_info' in env, false, `${name}: no error_info`);
    assert.equal('metadata' in env, false, `${name}: no metadata`);
    assert.equal('parameters' in env, false, `${name}: no parameters`);
    assert.equal('result' in env, false, `${name}: no result on error`);
  }
});

test('enhanced tools embed a type guide for format-class BRP errors', async () => {
  const catalog = loadToolContractCatalog();
  const fake = new FakeBrpClient();
  fake.error = new BrpJsonRpcError('world.insert_components', -23402, 'Unknown component type: `fake::Nope`');
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerDirectTools(server, fakeServices(fake), catalog);
  const result = await registeredHandler(server, 'world_insert_components')({
    entity: 42,
    components: { 'fake::Nope': {} },
    port: 7777,
  });

  const env = envelope(result);
  assert.equal(env.status, 'error');
  assert.equal(env.message, "Format error - see 'type_guide' field for correct format");
  const metadata = env.metadata as { original_error: string; type_guide: Record<string, unknown> };
  assert.equal(metadata.original_error, 'Unknown component type: `fake::Nope`');
  const guide = metadata.type_guide as { requested_types: string[]; type_guide: Record<string, unknown> };
  assert.deepEqual(guide.requested_types, ['fake::Nope']);
  assert.ok(guide.type_guide['fake::Nope']);
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
