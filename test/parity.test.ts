import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import {
  loadToolContractCatalog,
  overrideDescription,
  type CapturedToolContract,
  type ToolContractCatalog,
} from '../src/tool-contracts.js';
import { registerOwnedTool } from '../src/tools/register.js';
import { toolSuccess } from '../src/tools/response.js';
import { createOwnedServer } from '../src/server.js';

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

test('the owned server registers only contract tools (zero for now)', () => {
  const catalog = loadToolContractCatalog();
  const { server } = createOwnedServer();
  const knownNames = new Set(catalog.names());
  for (const name of Object.keys(registeredTools(server))) {
    assert.ok(knownNames.has(name), `non-contract tool registered: ${name}`);
  }
  assert.equal(Object.keys(registeredTools(server)).length, 0);
});
