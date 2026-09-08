import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import {
  loadToolContractCatalog,
  overrideDescription,
  type CapturedToolContract,
  type ToolContractCatalog,
} from '../src/tool-contracts.js';
import { registerDirectTools, registerOwnedTool } from '../src/tools/register.js';
import { toolSuccess } from '../src/tools/response.js';
import { RESOURCE_DIRECT } from '../src/tools/resources.js';
import { createOwnedServer } from '../src/server.js';
import { WORLD_DIRECT } from '../src/tools/world.js';
import { createServices } from '../src/services.js';

// The SDK keeps registered tools in this (compile-time private) record; reading
// it lets the parity test introspect exactly what the server advertises.
function registeredTools(server: McpServer): Record<string, RegisteredToolLike> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
}

interface RegisteredToolLike {
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

async function stubHandler(): Promise<ReturnType<typeof toolSuccess>> {
  return toolSuccess({ mcp_tool: 'parity-stub' }, 'stub');
}

/** Every locally registered tool must advertise its captured metadata. */
function assertParity(server: McpServer, catalog: ToolContractCatalog): void {
  const knownNames = new Set(catalog.names());
  for (const [name, registered] of Object.entries(registeredTools(server))) {
    assert.ok(
      knownNames.has(name),
      `locally registered tool "${name}" is not in the captured contract`,
    );
    const captured: CapturedToolContract = catalog.get(name);
    assert.equal(registered.title, captured.title, `${name}: title parity`);
    assert.equal(
      registered.description,
      overrideDescription(captured.description),
      `${name}: description parity after overrides`,
    );
    assert.deepEqual(registered.annotations, captured.annotations, `${name}: annotations parity`);
    assert.ok(registered.inputSchema, `${name}: inputSchema must be registered`);
    assert.ok(registered.outputSchema, `${name}: outputSchema must be registered`);
  }
}

test('registered tools advertise captured metadata (with reviewed description overrides)', () => {
  const catalog = loadToolContractCatalog();
  const server = new McpServer({ name: 'parity-test', version: '0.0.0' });
  // brp_list_logs is one of the tools whose captured description mentions the
  // retired `bevy_brp_mcp` log filenames, so it exercises the override path.
  registerOwnedTool(server, catalog, 'brp_list_logs', stubHandler);
  assertParity(server, catalog);

  const registered = registeredTools(server)['brp_list_logs'];
  assert.ok(registered);
  assert.ok(registered.description?.includes('bevy-mcp'));
  assert.ok(!registered.description?.includes('bevy_brp_mcp'));
});

test('locally registered tool names outside the captured contract are rejected', () => {
  const catalog = loadToolContractCatalog();
  const server = new McpServer({ name: 'parity-test', version: '0.0.0' });
  assert.throws(
    () => registerOwnedTool(server, catalog, 'brp_not_a_real_tool', stubHandler),
    /no captured contract for tool/,
  );
  assert.equal(Object.keys(registeredTools(server)).length, 0);
});

test('all direct tools advertise their captured contract over a real tools/list', async () => {
  const catalog = loadToolContractCatalog();
  const server = new McpServer({ name: 'parity-direct', version: '0.0.0' });
  registerDirectTools(server, createServices(), catalog);
  const client = new Client({ name: 'parity-direct-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  try {
    const directNames = [...Object.keys(WORLD_DIRECT), ...Object.keys(RESOURCE_DIRECT)];
    const { tools } = await client.listTools();
    assert.equal(tools.length, directNames.length);
    for (const name of directNames) {
      const advertised = tools.find((tool) => tool.name === name);
      assert.ok(advertised, `${name} must be advertised over tools/list`);
      const captured: CapturedToolContract = catalog.get(name);
      assert.equal(advertised.title, captured.title, `${name}: title parity`);
      assert.equal(
        advertised.description,
        overrideDescription(captured.description),
        `${name}: description parity after overrides`,
      );
      assert.deepEqual(advertised.annotations, captured.annotations, `${name}: annotations parity`);
      assert.deepEqual(advertised.inputSchema, captured.inputSchema, `${name}: input schema parity`);
      assert.deepEqual(
        advertised.outputSchema,
        captured.outputSchema,
        `${name}: output schema parity`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('the owned server registers exactly the 22 implemented contract tools', () => {
  const catalog = loadToolContractCatalog();
  const { server } = createOwnedServer();
  const knownNames = new Set(catalog.names());
  for (const name of Object.keys(registeredTools(server))) {
    assert.ok(knownNames.has(name), `non-contract tool registered: ${name}`);
  }
  assert.equal(Object.keys(registeredTools(server)).length, 22);
});
