import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export interface CapturedToolContract {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface CapturedContract {
  source: { version: string; commit: string };
  tools: CapturedToolContract[];
}

const contract: CapturedContract = JSON.parse(
  await readFile(new URL('../../contracts/bevy-brp-mcp-0.22.3-tools.json', import.meta.url), 'utf8'),
);

test('fixture pins the 0.22.3 upstream source', () => {
  assert.deepEqual(contract.source, {
    version: '0.22.3',
    commit: '85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b',
  });
});

test('exactly 47 default tools, all uniquely named', () => {
  assert.equal(contract.tools.length, 47);
  assert.equal(new Set(contract.tools.map((tool) => tool.name)).size, 47);
});

test('non-default mcp-debug tools are not captured', () => {
  assert.ok(!contract.tools.some((tool) => tool.name === 'brp_get_trace_log_path'));
  assert.ok(!contract.tools.some((tool) => tool.name === 'brp_set_tracing_level'));
});

test('every tool carries description, input schema, and output schema', () => {
  assert.ok(contract.tools.every((tool) => tool.description?.length));
  assert.ok(contract.tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object'));
  assert.ok(contract.tools.every((tool) => tool.outputSchema && typeof tool.outputSchema === 'object'));
});

test('every output schema requires the shared envelope fields', () => {
  for (const field of ['status', 'message', 'call_info'] as const) {
    assert.ok(
      contract.tools.every((tool) => (tool.outputSchema?.required as string[] | undefined)?.includes(field)),
      `expected every tool outputSchema.required to include ${field}`,
    );
  }
});
