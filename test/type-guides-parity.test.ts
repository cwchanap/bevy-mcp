import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createOwnedServer } from '../src/server.js';

// ===== Live fixture lifecycle (real BRP, no fake registry) =====
//
// The owned type-guide tools query the live fixture app's `registry.schema`
// over real BRP HTTP, exactly like production. One fixture instance is shared
// by every test in this file.
//
// Gating: the suite is skipped ONLY when explicitly opted out via
// BEVY_MCP_SKIP_FIXTURE_TESTS=1 (CI's `node_package` job sets it — it has no
// Bevy system deps; the `integration` job and local dev must NOT set it).
// Without the opt-out a missing fixture binary triggers ONE
// `cargo build -p bevy-mcp-fixture` attempt; if cargo or the build fails the
// suite FAILS loudly — the parity gate never silently vanishes.

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)); // compiled to .test-build/test/
const FIXTURE_BIN = `${REPO_ROOT}target/debug/bevy-mcp-fixture`;
const PORT = 15702;
const READY_TIMEOUT_MS = 60_000;
const GOLDENS_DIR = fileURLToPath(new URL('../../test/contracts/type-guides/', import.meta.url));

const SKIP_FIXTURE_TESTS = process.env.BEVY_MCP_SKIP_FIXTURE_TESTS === '1';

/** Build the fixture once per process; rejects loudly on any failure. */
let fixtureBuild: Promise<void> | undefined;
function ensureFixtureBinary(): Promise<void> {
  if (existsSync(FIXTURE_BIN)) return Promise.resolve();
  fixtureBuild ??= new Promise<void>((resolve, reject) => {
    console.error('[type-guides-parity] fixture binary missing — running cargo build -p bevy-mcp-fixture');
    const build = spawn('cargo', ['build', '-p', 'bevy-mcp-fixture'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    const fail = (message: string): void =>
      reject(
        new Error(
          `${message} Set BEVY_MCP_SKIP_FIXTURE_TESTS=1 to opt out of the live parity gate.`,
        ),
      );
    build.once('error', (error) =>
      fail(`cargo could not be started (${error.message}); the fixture binary is not built.`),
    );
    build.once('exit', (code) =>
      existsSync(FIXTURE_BIN)
        ? resolve()
        : fail(`'cargo build -p bevy-mcp-fixture' exited with ${code} and no fixture binary.`),
    );
  });
  return fixtureBuild;
}

interface Shared {
  client: Client;
  callTypeGuide(types: string[]): Promise<Record<string, unknown>>;
}

let shared: Shared | undefined;

/**
 * Remove ONLY run-specific metadata from a tool response before comparison;
 * preserve every semantic field (guides, paths, examples, guidance, errors).
 * The same normalization is applied to the committed upstream goldens and the
 * owned output, so both sides stay comparable.
 */
function normalizeTypeGuideResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTypeGuideResponse);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(timestamp|duration|duration_ms|elapsed|pid|process_id)$/i.test(key)) continue;
      out[key] = normalizeTypeGuideResponse(item);
    }
    return out;
  }
  return value;
}

/** Poll the fixture BRP endpoint until it answers rpc.discover. */
async function awaitFixtureReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'rpc.discover' }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // BRP not up yet.
    }
    if (Date.now() > deadline) throw new Error(`fixture BRP on port ${PORT} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function startFixture(): Promise<ChildProcess> {
  const fixture = spawn(FIXTURE_BIN, [], {
    env: { ...process.env, BRP_EXTRAS_PORT: String(PORT) },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    await awaitFixtureReady();
    return fixture;
  } catch (error) {
    fixture.kill('SIGKILL');
    throw error;
  }
}

test('type-guide parity against the live fixture', { skip: SKIP_FIXTURE_TESTS }, async (t) => {
  // Not opted out and no binary: build it once; a failure here FAILS the gate.
  await ensureFixtureBinary();

  // Shared fixture + owned server (in-process, real MCP framing, real BRP).
  const fixture = await startFixture();
  t.after(async () => {
    // No orphan: the fixture must be dead before the test file ends.
    fixture.kill('SIGTERM');
    const exit = await Promise.race([
      new Promise((resolve) => fixture.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    if (exit === 'timeout') fixture.kill('SIGKILL');
  });

  const { server } = createOwnedServer();
  const client = new Client({ name: 'type-guide-parity', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  t.after(() => client.close());

  shared = {
    client,
    async callTypeGuide(types) {
      const result = await client.callTool({
        name: 'brp_type_guide',
        arguments: { types, port: PORT },
      });
      assert.ok(!result.isError, `brp_type_guide(${types.join(', ')}) failed`);
      return result.structuredContent as Record<string, unknown>;
    },
  };

  await t.test('each golden type guide matches the upstream capture after normalization', async () => {
    const cases: readonly [string, string][] = [
      ['bevy_mcp_fixture::FixtureValue', 'fixture-value.json'],
      ['bevy_mcp_fixture::FixtureMode', 'nested-enum.json'],
      ['bevy_transform::components::transform::Transform', 'transform.json'],
      ['bevy_ecs::hierarchy::Children', 'entity-containing.json'],
      ['nonexistent::Missing::Type', 'missing-type.json'],
    ];
    for (const [typeName, goldenFile] of cases) {
      const golden = JSON.parse(readFileSync(`${GOLDENS_DIR}${goldenFile}`, 'utf8'));
      const owned = await shared!.callTypeGuide([typeName]);
      assert.deepEqual(
        normalizeTypeGuideResponse(owned),
        normalizeTypeGuideResponse(golden),
        `${goldenFile}: owned structuredContent must match the upstream golden`,
      );
    }
  });

  await t.test('one bad type does not abort the entire brp_type_guide result', async () => {
    const structured = (await shared!.callTypeGuide([
      'bevy_mcp_fixture::FixtureValue',
      'nonexistent::Missing::Type',
      'bevy_transform::components::transform::Transform',
    ])) as {
      message: string;
      result: {
        discovered_count: number;
        summary: { failed_discoveries: number; successful_discoveries: number; total_requested: number };
        type_guide: Record<string, { error?: string; in_registry: boolean }>;
      };
    };

    assert.equal(structured.result.summary.total_requested, 3);
    assert.equal(structured.result.discovered_count, 2);
    assert.equal(structured.result.summary.failed_discoveries, 1);
    assert.equal(structured.result.summary.successful_discoveries, 2);
    assert.equal(structured.message, 'Discovered 2 type(s)');

    const missing = structured.result.type_guide['nonexistent::Missing::Type'];
    assert.ok(missing, 'failed type still appears in the result');
    assert.equal(missing.in_registry, false);
    assert.equal(missing.error, 'Type not found in registry');
    assert.ok(
      !('mutation_paths' in structured.result.type_guide['nonexistent::Missing::Type' as string]),
      'failed guides carry no mutation paths',
    );
    const good = structured.result.type_guide['bevy_mcp_fixture::FixtureValue'];
    assert.ok(good && !('error' in structured.result.type_guide['bevy_mcp_fixture::FixtureValue']));
  });

  await t.test('brp_all_type_guides covers representative types with consistent counts', async () => {
    const result = await client.callTool(
      { name: 'brp_all_type_guides', arguments: { port: PORT } },
      { timeout: 120_000 },
    );
    assert.ok(!result.isError, `brp_all_type_guides failed: ${JSON.stringify(result.content)}`);
    const response = result.structuredContent as {
      message: string;
      metadata: { type_count: number };
      result: {
        discovered_count: number;
        requested_types: string[];
        summary: {
          failed_discoveries: number;
          successful_discoveries: number;
          total_requested: number;
        };
        type_guide: Record<string, unknown>;
      };
    };

    // Summary arithmetic over the deduplicated guide set.
    assert.equal(response.result.summary.total_requested, response.result.requested_types.length);
    assert.ok(response.result.discovered_count > 100, 'the live registry exposes many types');
    assert.equal(
      response.result.summary.successful_discoveries + response.result.summary.failed_discoveries,
      Object.keys(response.result.type_guide).length,
      'successful + failed must cover every emitted guide',
    );
    assert.equal(response.result.discovered_count, response.result.summary.successful_discoveries);
    assert.equal(response.metadata.type_count, response.result.discovered_count);
    assert.equal(
      response.message,
      `Discovered schemas for all ${response.result.discovered_count} registered type(s)`,
    );

    // Representative types: fixture types, Entity-containing, transform, name.
    // (`Entity` itself has a registry schema but is not a component/resource,
    // so it correctly never appears in the merged component/resource lists.)
    for (const typeName of [
      'bevy_mcp_fixture::FixtureValue',
      'bevy_mcp_fixture::FixtureMode',
      'bevy_transform::components::transform::Transform',
      'bevy_ecs::hierarchy::Children',
      'bevy_ecs::name::Name',
    ]) {
      assert.ok(
        typeName in response.result.type_guide,
        `representative type ${typeName} missing from all-types result`,
      );
    }
  });
});
