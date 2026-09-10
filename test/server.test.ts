import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import {
  toolError,
  toolSuccess,
  type CallInfo,
  type ToolCallJsonResponse,
} from '../src/tools/response.js';
import { registerOwnedTool } from '../src/tools/register.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';

const localCall: CallInfo = { mcp_tool: 'brp_list_logs' };
const brpCall: CallInfo = { mcp_tool: 'world_spawn_entity', brp_method: 'world.spawn_entity' };

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

test('toolSuccess emits status, message, call_info, and optional fields incl. result', () => {
  const result = toolSuccess(brpCall, 'spawned', {
    result: { entity_id: 42 },
    metadata: { duration_ms: 3 },
  });
  const envelopeValue = envelope(result);
  assert.equal(envelopeValue.status, 'success');
  assert.equal(envelopeValue.message, 'spawned');
  assert.deepEqual(envelopeValue.call_info, brpCall);
  assert.deepEqual(envelopeValue.result, { entity_id: 42 });
  assert.deepEqual(envelopeValue.metadata, { duration_ms: 3 });
  assert.notEqual(result.isError, true);
  // The text content mirrors the structured envelope.
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), envelopeValue);
});

test('toolSuccess omits result and other optional fields when absent', () => {
  const envelopeValue = envelope(toolSuccess(localCall, 'listed'));
  assert.equal(envelopeValue.status, 'success');
  assert.equal(envelopeValue.message, 'listed');
  assert.deepEqual(envelopeValue.call_info, localCall);
  for (const key of ['metadata', 'parameters', 'result', 'error_info', 'brp_extras_debug_info']) {
    assert.equal(key in envelopeValue, false, `${key} must be absent`);
  }
});

test('toolError sets isError and carries metadata and error_info', () => {
  const result = toolError(localCall, 'BRP unreachable', {
    metadata: { attempt: 1 },
    error_info: { code: 'ECONNREFUSED' },
  });
  const envelopeValue = envelope(result);
  assert.equal(envelopeValue.status, 'error');
  assert.equal(envelopeValue.message, 'BRP unreachable');
  assert.deepEqual(envelopeValue.call_info, localCall);
  assert.deepEqual(envelopeValue.metadata, { attempt: 1 });
  assert.deepEqual(envelopeValue.error_info, { code: 'ECONNREFUSED' });
  assert.equal(result.isError, true);
});

test('toolSuccess normalizes null optionals into optional_parameters_not_provided', () => {
  const envelopeValue = envelope(
    toolSuccess(localCall, 'listed', {
      parameters: { app_name: 'bevy_app', verbose: null, port: null },
    }),
  );
  assert.deepEqual(envelopeValue.parameters, {
    app_name: 'bevy_app',
    optional_parameters_not_provided: ['verbose', 'port'],
  });
});

test('parameter echo regenerates the text content from the final structuredContent', async () => {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerOwnedTool(
    server,
    loadToolContractCatalog(),
    'brp_list_bevy',
    async () =>
      toolSuccess({ mcp_tool: 'brp_list_bevy' }, 'Found 0 Bevy targets', {
        metadata: { count: 0 },
        result: [],
        parameters: { path: null },
      }),
  );
  const handler = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools['brp_list_bevy'].handler;

  const result = await handler({ path: null });
  const envelopeValue = envelope(result);

  // The echo was applied to structuredContent (null optional normalized)...
  assert.deepEqual(envelopeValue.parameters, { optional_parameters_not_provided: ['path'] });
  // ...and the text content is exactly that final envelope, one source.
  assert.equal((result.content[0] as { text: string }).text, JSON.stringify(envelopeValue));
});

test('tool catalog exposes exactly the 47 captured tools and throws on unknown', () => {
  const catalog = loadToolContractCatalog();
  const names = catalog.names();
  assert.equal(names.length, 47);
  assert.deepEqual(names, [...names].sort());
  const listLogs = catalog.get('brp_list_logs');
  assert.equal(listLogs.name, 'brp_list_logs');
  assert.equal(typeof listLogs.description, 'string');
  assert.throws(() => catalog.get('brp_not_a_tool'), /no captured contract for tool/);
});
