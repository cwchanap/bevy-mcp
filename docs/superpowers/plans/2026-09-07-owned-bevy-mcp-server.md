# Owned Bevy MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external `bevy_brp_mcp` launcher with a complete repository-owned TypeScript MCP server that matches the pinned 0.22.3 default 47-tool public contract and behavior, then remove all upstream runtime/build/install/subprocess/CI dependency before the PR is complete.

**Architecture:** Develop the owned server beside the existing launcher until differential parity is proven. Capture the upstream 0.22.3 `tools/list` response once as licensed checked-in contract data and use it to register exact names/titles/descriptions/annotations/input/output schemas through the official MCP server SDK. Implement local BRP call/stream transport, composites, full type-guide behavior, Cargo/process/log/watch ownership, run the same fixture journey against upstream and owned servers, then cut over `src/index.ts` and delete the launcher/upstream CI install in the same PR.

**Tech Stack:** Node.js >=20, TypeScript `^5.3.3` unless the MCP server SDK proves a higher minimum, `@modelcontextprotocol/server` 2.x, `@modelcontextprotocol/client` 2.x for capture/integration, native `fetch`, `child_process`, `fs`, Rust >=1.95, Bevy 0.19.x, `bevy_brp_extras` 0.22.3, GitHub Actions/Xvfb.

**Spec:** `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`

## Global Constraints

- One task/ticket = one PR. All tasks below stay on `agent/owned-bevy-mcp-server-plan` and PR #3.
- Final merged code has zero runtime/build/install/subprocess/fallback/CI dependency on `bevy_brp_mcp`.
- The existing launcher may remain temporarily only as a migration test oracle; it is deleted before final gates.
- Pinned reference: `natepiano/bevy_brp` commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, package `bevy_brp_mcp` 0.22.3.
- Own exactly the 47 default tools; do not add the two non-default `mcp-debug` trace tools.
- `brp_execute` remains a first-class explicit tool and is never another tool's fallback.
- Keep `bevy_brp_extras = 0.22.3` and the Rust bridge unchanged except fixture/test support.
- Preserve captured tool names, titles, descriptions, annotations, input schemas, output schema, and public parameter behavior except an explicit reviewed allowlist for obsolete implementation-name prose.
- Do not hand-roll MCP framing.
- Do not add a database, daemon, DI framework, generic tool-codegen system, custom Cargo freshness layer, polling watches, remote-host support, WASM relay, or game-specific commands.
- Spawned Bevy children remain referenced and are shut down with the MCP session.
- `LogStore` alone owns app/watch paths; log tool callers pass filenames/app filters, never absolute paths.
- `brp_all_type_guides` keeps its upstream port-only public contract.

---

## Planned file structure

```text
contracts/
  bevy-brp-mcp-0.22.3-tools.json
THIRD_PARTY_NOTICES.md

src/
  index.ts                     # legacy launcher entry until cutover
  launcher.ts                  # retained until differential gate
  owned-index.ts               # temporary owned-server entry during migration
  server.ts
  services.ts
  tool-contracts.ts
  brp/
    client.ts
    errors.ts
    types.ts
  runtime/
    cargo.ts
    process-manager.ts
    log-store.ts
    watch-manager.ts
  tools/
    register.ts
    response.ts
    world.ts
    resources.ts
    discovery.ts
    agent-tools.ts
    extras.ts
    watches.ts
    app.ts
    logs.ts
    type-guides/
      index.ts
      model.ts
      schema-info.ts
      value-builder.ts
      type-knowledge.ts
      mutation-paths.ts
      guidance.ts

test/
  contract-fixture.test.ts
  parity.test.ts
  server.test.ts
  brp-client.test.ts
  world-tools.test.ts
  discovery-tools.test.ts
  extras-tools.test.ts
  watch-manager.test.ts
  watch-tools.test.ts
  cargo.test.ts
  process-manager.test.ts
  log-store.test.ts
  log-tools.test.ts
  app-tools.test.ts
  type-guides-core.test.ts
  type-guides-parity.test.ts
  upstream-independence.test.ts
  contracts/type-guides/
    fixture-value.json
    nested-enum.json
    transform.json
    entity-containing.json
    missing-type.json

scripts/
  integration.mjs
  integration-name-smoke.mjs
  smoke-packed-cli.mjs

fixtures/full-app/src/main.rs
package.json
package-lock.json
README.md
CLAUDE.md
AGENTS.md -> CLAUDE.md
.github/workflows/ci.yml
```

Delete before PR completion:

```text
src/launcher.ts
src/owned-index.ts             # owned entry moves to src/index.ts
 test/launcher.test.ts
docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md
docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md
```

---

### Task 0: Capture the licensed upstream public contract once

**Files:**
- Create: `contracts/bevy-brp-mcp-0.22.3-tools.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `test/contract-fixture.test.ts`
- Modify: `package.json` only if a test script needs no existing equivalent

**Interfaces:**

```ts
export interface CapturedToolContract {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
```

- [ ] **Step 1: Build the current launcher and confirm the pinned oracle**

Run:

```bash
npm ci
npm run build
bevy_brp_mcp --version
```

Expected version: `0.22.3`. If it is absent in the implementation environment, install **only for this migration oracle task**:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

This install is not added to final product prerequisites and is removed from CI before PR completion.

- [ ] **Step 2: Capture `tools/list` through the existing launcher**

Run from repo root:

```bash
mkdir -p contracts
BEVY_BRP_MCP_BIN=bevy_brp_mcp node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'bevy-contract-capture', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/index.js'],
  cwd: process.cwd(),
  stderr: 'inherit',
  env: { ...process.env, BEVY_BRP_MCP_BIN: 'bevy_brp_mcp' },
});
await client.connect(transport);
const { tools } = await client.listTools();
const captured = tools
  .map(({ name, title, description, annotations, inputSchema, outputSchema }) => ({
    name, title, description, annotations, inputSchema, outputSchema,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
if (captured.length !== 47) throw new Error(`expected 47 default tools, got ${captured.length}`);
if (captured.some((tool) => tool.name === 'brp_get_trace_log_path' || tool.name === 'brp_set_tracing_level')) {
  throw new Error('mcp-debug tools leaked into default capture');
}
await writeFile(
  'contracts/bevy-brp-mcp-0.22.3-tools.json',
  `${JSON.stringify({ source: { version: '0.22.3', commit: '85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b' }, tools: captured }, null, 2)}\n`,
);
await client.close();
NODE
```

- [ ] **Step 3: Add contract-fixture tests**

`test/contract-fixture.test.ts` must assert:

```ts
assert.equal(contract.tools.length, 47);
assert.equal(new Set(contract.tools.map((tool) => tool.name)).size, 47);
assert.ok(contract.tools.every((tool) => tool.description?.length));
assert.ok(contract.tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object'));
assert.ok(contract.tools.every((tool) => tool.outputSchema && typeof tool.outputSchema === 'object'));
```

Also assert every output schema has required fields containing `status`, `message`, and `call_info`.

- [ ] **Step 4: Add attribution**

Create `THIRD_PARTY_NOTICES.md` identifying `natepiano/bevy_brp`, the pinned commit, `bevy_brp_mcp`, and that captured tool descriptions/schema metadata and later translated type-guide portions are used under the upstream MIT license. Include the upstream MIT permission/warranty text from `mcp/LICENSE-MIT`.

- [ ] **Step 5: Run and commit**

```bash
npm test
```

```bash
git add contracts THIRD_PARTY_NOTICES.md test/contract-fixture.test.ts package.json
git commit -m "test: capture upstream Bevy MCP contract"
```

---

### Task 1: Build the owned MCP server beside the legacy launcher

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/owned-index.ts`
- Create: `src/server.ts`
- Create: `src/services.ts`
- Create: `src/tool-contracts.ts`
- Create: `src/tools/register.ts`
- Create: `src/tools/response.ts`
- Create: `test/server.test.ts`
- Create: `test/parity.test.ts`
- Keep unchanged: `src/index.ts`, `src/launcher.ts`, `test/launcher.test.ts`

**Interfaces:**

```ts
export type ResponseStatus = 'success' | 'error';
export type CallInfo =
  | { mcp_tool: string }
  | { mcp_tool: string; brp_method: string };

export interface ToolCallJsonResponse {
  status: ResponseStatus;
  message: string;
  call_info: CallInfo;
  metadata?: unknown;
  parameters?: unknown;
  result?: unknown;
  error_info?: unknown;
  brp_extras_debug_info?: unknown;
}

export class ToolContractCatalog {
  get(name: string): CapturedToolContract;
  names(): string[];
}

export function registerOwnedTool(
  server: McpServer,
  catalog: ToolContractCatalog,
  name: string,
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
): void;
```

- [ ] **Step 1: Add only the MCP server dependency**

Keep TypeScript 5.x:

```json
"dependencies": {
  "@modelcontextprotocol/server": "^2.0.0"
},
"devDependencies": {
  "@modelcontextprotocol/client": "^2.0.0",
  "@types/node": "^20.11.24",
  "typescript": "^5.3.3"
}
```

Use `npm install` and let compilation reveal if the SDK requires a minimum TypeScript 5.x bump. Do not add a compiler-major migration.

- [ ] **Step 2: Load the checked-in contract and define the reviewed override map**

`src/tool-contracts.ts` reads:

```text
../contracts/bevy-brp-mcp-0.22.3-tools.json
```

relative to compiled `build/`. Add a small map containing only known description substitutions for retired upstream log filename wording. No name/input/output/annotation overrides are allowed initially.

Package `contracts/**` and `THIRD_PARTY_NOTICES.md` via `package.json.files`.

- [ ] **Step 3: Register raw captured schemas through the official SDK**

Use:

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';
```

For each implemented tool, `registerOwnedTool` passes captured `title`, `description`, `annotations`, `fromJsonSchema(inputSchema)`, and `fromJsonSchema(outputSchema)` to `server.registerTool(...)`.

- [ ] **Step 4: Implement the exact shared response helpers**

Provide `toolSuccess()` and `toolError()` that always emit `status`, `message`, and `call_info`, make `result` optional, add optional fields only when present, and set MCP `isError` for error responses.

Normalized parameters follow upstream behavior: remove top-level `null` optionals and append their names under `optional_parameters_not_provided` inside `parameters`.

Unit test a success with `result`, a success without `result`, and an error carrying `metadata`/`error_info`.

- [ ] **Step 5: Create a temporary owned stdio entrypoint**

`src/owned-index.ts` creates services/server, connects `StdioServerTransport`, and uses one idempotent cleanup function:

```text
watches.stopAll()
-> processes.shutdownAll()
-> server.close()
```

Do not modify the package bin or legacy `src/index.ts` yet.

- [ ] **Step 6: Add initial parity tests**

`test/parity.test.ts` loads the captured contract and verifies that any locally registered tool advertises metadata equal to its captured entry after the explicit description override function. The test is incremental: it compares implemented names only until the full-catalog task, but rejects any unlisted/unknown local tool immediately.

- [ ] **Step 7: Run and commit**

```bash
npm run typecheck
npm run build
npm test
```

```bash
git add package.json package-lock.json src test
git commit -m "feat: scaffold owned Bevy MCP server"
```

---

### Task 2: Implement instant and streaming BRP transport

**Files:**
- Create: `src/brp/client.ts`
- Create: `src/brp/errors.ts`
- Create: `src/brp/types.ts`
- Create: `test/brp-client.test.ts`
- Modify: `src/services.ts`

**Interfaces:**

```ts
export const DEFAULT_BRP_PORT = 15702;

export interface BrpCallOptions {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class BrpClient {
  call<T>(method: string, params?: unknown, options?: BrpCallOptions): Promise<T>;
  stream(method: string, params: unknown, options?: Omit<BrpCallOptions, 'timeoutMs'>): Promise<Response>;
  discover(port?: number): Promise<unknown>;
}
```

- [ ] **Step 1: Test instant JSON-RPC behavior**

Use a local Node HTTP server and cover success, JSON-RPC error, malformed JSON, HTTP failure, connection failure, caller abort, and timeout. Assert localhost URL, numeric request ID, method, params, and no retry.

- [ ] **Step 2: Test unsafe integer rejection**

Return JSON containing an integer larger than `Number.MAX_SAFE_INTEGER` and assert the client rejects with a precision error rather than returning the parsed value. Apply the recursive guard to decoded JSON after parsing so unsafe entity IDs and integer component values fail loudly.

- [ ] **Step 3: Test streaming setup**

Serve a chunked/SSE response and assert `stream()` resolves once headers are established, preserves the caller abort signal, and does not apply the normal request timeout.

- [ ] **Step 4: Implement `call`, `stream`, and `discover`**

`discover(port)` remains exactly an instant `rpc.discover` call. `stream()` returns the raw successful `Response` to `WatchManager`; it does not parse SSE in the generic BRP client.

- [ ] **Step 5: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/brp-client.test.js
npm run typecheck
```

```bash
git add src/brp src/services.ts test/brp-client.test.ts
git commit -m "feat: add owned Bevy BRP transport"
```

---

### Task 3: Implement direct world/resource tools from captured contracts

**Files:**
- Create: `src/tools/world.ts`
- Create: `src/tools/resources.ts`
- Create: `test/world-tools.test.ts`
- Modify: `src/tools/register.ts`
- Modify: `test/parity.test.ts`

**Interfaces:**

```ts
export function registerDirectBrpTool(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
  definition: { name: string; method: string },
): void;
```

- [ ] **Step 1: Add exact fixed mappings**

```ts
const WORLD_DIRECT = {
  world_list_components: 'world.list_components',
  world_get_components: 'world.get_components',
  world_despawn_entity: 'world.despawn_entity',
  world_insert_components: 'world.insert_components',
  world_remove_components: 'world.remove_components',
  world_mutate_components: 'world.mutate_components',
  world_query: 'world.query',
  world_spawn_entity: 'world.spawn_entity',
  world_trigger_event: 'world.trigger_event',
  registry_schema: 'registry.schema',
  world_reparent_entities: 'world.reparent_entities',
  rpc_discover: 'rpc.discover',
} as const;

const RESOURCE_DIRECT = {
  world_list_resources: 'world.list_resources',
  world_get_resources: 'world.get_resources',
  world_insert_resources: 'world.insert_resources',
  world_remove_resources: 'world.remove_resources',
  world_mutate_resources: 'world.mutate_resources',
} as const;
```

- [ ] **Step 2: Implement one direct helper**

The SDK validates args against the captured input schema. The helper extracts `port` for routing, forwards remaining fields to the fixed BRP method, and creates the standard response with captured contract metadata.

Do not accept a dynamic method from caller input.

- [ ] **Step 3: Test every mapping**

Use a fake `BrpClient` and assert method, port, forwarded params, `call_info`, normalized `parameters`, result placement, and BRP error conversion for every mapping.

- [ ] **Step 4: Extend parity coverage**

For all registered direct tools, assert actual `tools/list` title/description/annotations/input/output schema equals the captured contract after allowed prose overrides.

- [ ] **Step 5: Run and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/tools test
git commit -m "feat: add direct Bevy world tools"
```

---

### Task 4: Implement live name discovery and application agent tools

**Files:**
- Modify: `fixtures/full-app/src/main.rs`
- Create: `scripts/integration-name-smoke.mjs`
- Create: `src/tools/discovery.ts`
- Create: `src/tools/agent-tools.ts`
- Create: `test/discovery-tools.test.ts`
- Modify: `src/tools/register.ts`
- Modify: `package.json`

- [ ] **Step 1: Expand the fixture first**

Add/register:

```rust
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct FixtureValue { value: i32 }

#[derive(Component, Reflect)]
#[reflect(Component)]
enum FixtureMode {
    Idle,
    Moving { speed: f32 },
}
```

Add `counter: i32` to `FixtureState`. Spawn the visible primary entity with:

```rust
Name::new("FixturePrimary")
FixtureMarker
FixtureValue { value: 1 }
FixtureMode::Moving { speed: 2.0 }
```

- [ ] **Step 2: Test/implement `world_find_entities_by_name`**

The reflected path is exactly `bevy_ecs::name::Name`. Issue one `world.query` with that path in both `data.components` and `filter.with`. Decode the live Bevy 0.19 Name payload, support exact/prefix/suffix/contains, preserve case sensitivity/literal `*`, sort by entity ID, and reject unsafe IDs.

- [ ] **Step 3: Test/implement `brp_execute`**

Call `rpc.discover`, reject a method not present in discovery, then invoke the requested BRP method through `BrpClient`. No other handler imports this handler.

- [ ] **Step 4: Test/implement `brp_list_agent_tools`**

Call `brp_extras/agent_tools`. Preserve its result and upstream-compatible error metadata, including catalog request method/port/code where relevant.

- [ ] **Step 5: Add the early live name smoke**

`scripts/integration-name-smoke.mjs` starts the fixture directly with `BRP_EXTRAS_PORT=15702`, starts `build/owned-index.js`, calls `world_find_entities_by_name`, and asserts one `FixturePrimary` with a safe numeric entity ID. It then closes both processes.

- [ ] **Step 6: Run and commit**

```bash
cargo test --workspace
npm run build
npm test
xvfb-run -a node scripts/integration-name-smoke.mjs
```

```bash
git add fixtures scripts src/tools test package.json
git commit -m "feat: add Bevy discovery composites"
```

---

### Task 5: Port the type-guide core and schema/value model

**Files:**
- Create: `src/tools/type-guides/model.ts`
- Create: `src/tools/type-guides/schema-info.ts`
- Create: `src/tools/type-guides/value-builder.ts`
- Create: `src/tools/type-guides/type-knowledge.ts`
- Create: `test/type-guides-core.test.ts`
- Modify: `THIRD_PARTY_NOTICES.md` only if attribution wording needs the translated modules named explicitly

**Interfaces:**

```ts
export interface TypeGuide {
  type_name: string;
  in_registry: boolean;
  spawn_insert_example?: unknown;
  agent_guidance: string;
  mutation_paths?: unknown[];
  schema_info?: unknown;
  error?: string;
}
```

- [ ] **Step 1: Capture deterministic registry fixtures from the live Bevy fixture**

Add test fixtures for `FixtureValue`, `FixtureMode`, Bevy `Transform`, an Entity-containing type, and referenced nested types by querying `registry.schema` from the fixture. Commit these under `test/contracts/type-guides/registry/` if needed by pure unit tests.

- [ ] **Step 2: Port type-name/kind/schema-info behavior**

Translate only the upstream behavior required to reproduce default guide output: registry presence, fully-qualified names, type kinds, properties, required fields, module/crate path, reflect traits, and component info.

- [ ] **Step 3: Port example-value/type-knowledge behavior**

Translate the curated upstream values needed for Bevy special types and generic primitives/containers/enums. Substantially derived tables/functions receive source comments referencing the pinned commit and MIT notice.

- [ ] **Step 4: Unit-test representative types**

Cover primitive fields, struct, tuple/tuple-struct, enum variants, list/array, map/set, nested refs, Entity, Transform-related types, missing/unregistered type, and a processing failure that returns a per-type `error` rather than crashing the request.

- [ ] **Step 5: Run and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/tools/type-guides test/contracts/type-guides test/type-guides-core.test.ts THIRD_PARTY_NOTICES.md
git commit -m "feat: port Bevy type guide core"
```

---

### Task 6: Complete mutation paths, guidance, and type-guide parity

**Files:**
- Create: `src/tools/type-guides/mutation-paths.ts`
- Create: `src/tools/type-guides/guidance.ts`
- Create: `src/tools/type-guides/index.ts`
- Create: `test/type-guides-parity.test.ts`
- Create: `test/contracts/type-guides/fixture-value.json`
- Create: `test/contracts/type-guides/nested-enum.json`
- Create: `test/contracts/type-guides/transform.json`
- Create: `test/contracts/type-guides/entity-containing.json`
- Create: `test/contracts/type-guides/missing-type.json`
- Modify: `src/tools/register.ts`

- [ ] **Step 1: Capture upstream type-guide goldens before cutover**

Using the current launcher/upstream oracle and the expanded fixture, call `brp_type_guide` for the five representative types and store normalized `structuredContent` goldens. Remove only run-specific metadata; preserve guide result, mutation paths, spawn example, agent guidance, schema info, and errors.

- [ ] **Step 2: Port mutation-path construction**

Implement the upstream default semantics for struct fields, tuples, tuple structs, arrays/lists, maps/sets, enum variants, nested references, and mutation-capability decisions. Use the same external path/result shape as the captured goldens.

- [ ] **Step 3: Port spawn/insert examples and agent guidance**

Construct `spawn_insert_example` from available mutation paths/reflect traits and reproduce the default guidance, including the Entity-specific warning/value example.

- [ ] **Step 4: Implement both public type tools**

`brp_type_guide` resolves requested types and returns upstream-compatible success/failure result semantics.

`brp_all_type_guides` keeps only its captured `port` parameter and complete result. Reuse one loaded registry/type dataset rather than issuing N redundant requests.

- [ ] **Step 5: Golden-test semantic parity**

Owned output for all five goldens must match after the same normalization function. Add an all-types test asserting representative types are present, discovered/failed counts match expected semantics, and one bad type does not abort the entire result.

- [ ] **Step 6: Run and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/tools/type-guides src/tools/register.ts test/type-guides-parity.test.ts test/contracts/type-guides
git commit -m "feat: complete Bevy type guide parity"
```

---

### Task 7: Implement the complete extras family

**Files:**
- Create: `src/tools/extras.ts`
- Create: `test/extras-tools.test.ts`
- Modify: `src/tools/register.ts`
- Modify: `test/parity.test.ts`

- [ ] **Step 1: Register the 13 simple fixed extras mappings**

```ts
const EXTRAS_DIRECT = {
  brp_extras_send_keys: 'brp_extras/send_keys',
  brp_extras_type_text: 'brp_extras/type_text',
  brp_extras_set_window_title: 'brp_extras/set_window_title',
  brp_extras_move_mouse: 'brp_extras/move_mouse',
  brp_extras_send_mouse_button: 'brp_extras/send_mouse_button',
  brp_extras_click_mouse: 'brp_extras/click_mouse',
  brp_extras_double_click_mouse: 'brp_extras/double_click_mouse',
  brp_extras_drag_mouse: 'brp_extras/drag_mouse',
  brp_extras_scroll_mouse: 'brp_extras/scroll_mouse',
  brp_extras_pinch_gesture: 'brp_extras/pinch_gesture',
  brp_extras_rotation_gesture: 'brp_extras/rotation_gesture',
  brp_extras_double_tap_gesture: 'brp_extras/double_tap_gesture',
  brp_extras_get_diagnostics: 'brp_extras/get_diagnostics',
} as const;
```

Captured schemas provide argument validation.

- [ ] **Step 2: Test screenshot composite modes**

Cover full, camera-only, entity, exact-name unique match, `entity+name` rejection, padding-without-selector rejection, zero matches, and duplicate-name candidate IDs.

- [ ] **Step 3: Implement `brp_extras_screenshot` explicitly**

Name mode uses `findEntitiesByName(... exact ...)`, requires one match, forwards canonical entity/camera/padding/path to `brp_extras/screenshot`, and returns the standard envelope. It never calls `brp_execute`.

- [ ] **Step 4: Run parity/tests and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/tools/extras.ts src/tools/register.ts test
git commit -m "feat: add Bevy extras MCP tools"
```

---

### Task 8: Implement owned LogStore and native SSE watches

**Files:**
- Create: `src/runtime/log-store.ts`
- Create: `src/runtime/watch-manager.ts`
- Create: `src/tools/watches.ts`
- Create: `test/log-store.test.ts`
- Create: `test/watch-manager.test.ts`
- Create: `test/watch-tools.test.ts`
- Modify: `src/services.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**

```ts
export class LogStore {
  createAppLog(appName: string): Promise<{ filename: string; path: string }>;
  createWatchLog(watchId: number, entity: number, kind: string): Promise<{ filename: string; path: string }>;
  list(options: { appName?: string; verbose?: boolean }): Promise<unknown[]>;
  read(filename: string, options: { keyword?: string; tailLines?: number }): Promise<unknown>;
  delete(options: { appName?: string; olderThanSeconds?: number }): Promise<string[]>;
}

export interface ActiveWatch {
  id: number;
  kind: 'get_components' | 'list_components';
  entity: number;
  types?: string[];
  port: number;
  filename: string;
  path: string;
}
```

- [ ] **Step 1: Implement LogStore path ownership/security**

Owned roots are `<tmp>/bevy-mcp/apps` and `<tmp>/bevy-mcp/watches`. Allocation sanitizes names. `read()` resolves only a filename under owned roots, rejects traversal/absolute input, supports case-insensitive `keyword`, and applies `tailLines`. `delete()` filters by app name and modification age.

- [ ] **Step 2: Test an SSE line parser**

Feed arbitrary chunk boundaries including `data:` lines split across chunks, CRLF/LF, blank lines, malformed JSON records, and multiple events in one chunk. Valid JSON-RPC `result` values become update records; malformed/non-data lines do not crash the watch loop.

- [ ] **Step 3: Implement WatchManager using `BrpClient.stream()`**

For get-components use `world.get_components+watch`; for list-components use `world.list_components+watch`. Allocate a watch log through `LogStore`, establish the HTTP stream successfully, then assign/register the monotonic numeric ID and process the stream in the background with an AbortController.

On stream end/error, remove the watch and append the appropriate ended/error record. `stop(id)` aborts the stream; `stopAll()` aborts every active watch.

- [ ] **Step 4: Implement the four watch tools**

- `world_get_components_watch`
- `world_list_components_watch`
- `brp_list_active_watches`
- `brp_stop_watch`

Captured schemas enforce the public parameter names. Start tools return watch ID/log filename/path in upstream-compatible fields; stopping an unknown ID is a tool error.

- [ ] **Step 5: Run and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/runtime src/tools/watches.ts src/services.ts src/tools/register.ts test
git commit -m "feat: add Bevy SSE watches and log store"
```

---

### Task 9: Implement Cargo target discovery and build artifact resolution

**Files:**
- Create: `src/runtime/cargo.ts`
- Create: `test/cargo.test.ts`
- Modify: `src/services.ts`

**Interfaces:**

```ts
export interface BevyTarget {
  name: string;
  kind: 'app' | 'example';
  packageName: string;
  manifestPath: string;
  packageRoot: string;
}

export class CargoRuntime {
  listTargets(root?: string): Promise<BevyTarget[]>;
  build(target: BevyTarget, profile: 'debug' | 'release'): Promise<{ executable: string }>;
}
```

- [ ] **Step 1: Test Cargo metadata normalization with fixtures**

Cover bins, examples, duplicate names across packages, package/path scoping, and deterministic ordering.

- [ ] **Step 2: Implement `cargo metadata --format-version 1 --no-deps`**

Resolve supplied directory/Cargo.toml to a manifest. Normalize only executable app/example targets.

- [ ] **Step 3: Test/implement compiler-artifact parsing**

Build with `--message-format=json-render-diagnostics`, select the exact package/target artifact with non-null `executable`, add `--release` only when requested, and never predict `target/` paths or implement freshness checks.

- [ ] **Step 4: Add one real workspace metadata/build smoke**

Use the existing fixture target to verify `listTargets(repoRoot)` finds `bevy-mcp-fixture` and a debug build produces an existing executable path.

- [ ] **Step 5: Run and commit**

```bash
npm test
cargo build -p bevy-mcp-fixture
```

```bash
git add src/runtime/cargo.ts src/services.ts test/cargo.test.ts
git commit -m "feat: add Bevy Cargo runtime"
```

---

### Task 10: Implement process/app lifecycle and exact log tools

**Files:**
- Create: `src/runtime/process-manager.ts`
- Create: `src/tools/app.ts`
- Create: `src/tools/logs.ts`
- Create: `test/process-manager.test.ts`
- Create: `test/app-tools.test.ts`
- Create: `test/log-tools.test.ts`
- Modify: `src/services.ts`
- Modify: `src/tools/register.ts`

- [ ] **Step 1: Implement tracked process lifecycle without `unref()`**

`ProcessManager.launch()` receives an executable, args/env/port, and LogStore-provided app log path. Merge environment in this order:

```text
process.env < user env < BRP_EXTRAS_PORT=<assigned port>
```

Track child objects/PIDs until exit. Unit test normal exit, termination, and `shutdownAll()` idempotence.

- [ ] **Step 2: Implement `brp_list_bevy` and `brp_launch`**

Preserve captured input contract. Launch resolution: path/workspace, app/example search order, optional package disambiguation, consecutive port validation, one Cargo build per selected target/profile, one or more referenced spawns, returned PIDs/ports/log metadata.

- [ ] **Step 3: Implement `brp_status` and `brp_shutdown`**

Status combines tracked process state with a live `rpc.discover` readiness probe. Shutdown calls `brp_extras/shutdown`, waits a bounded interval, then terminates a tracked child still alive and reports the method used.

- [ ] **Step 4: Implement exact log public contracts**

`brp_list_logs` accepts only `{ app_name?, verbose? }` and delegates to `LogStore.list`.

`brp_read_log` accepts only `{ filename, keyword?, tail_lines? }` and delegates to `LogStore.read`.

`brp_delete_logs` accepts only `{ app_name?, older_than_seconds? }` and delegates to `LogStore.delete`.

No log tool accepts `port` or caller-supplied path.

- [ ] **Step 5: Test contract parity and behavior**

Assert actual tool metadata matches captured schemas/descriptions/annotations; unit-test keyword filtering, tail mode, age/app filters, traversal rejection, process readiness, launch ambiguity, and shutdown fallback.

- [ ] **Step 6: Run and commit**

```bash
npm test
npm run typecheck
```

```bash
git add src/runtime/process-manager.ts src/tools src/services.ts test
git commit -m "feat: own Bevy app lifecycle and logs"
```

---

### Task 11: Complete 47-tool registration and run upstream-vs-owned differential parity

**Files:**
- Modify: `src/tools/register.ts`
- Modify: `scripts/integration.mjs`
- Modify: `test/parity.test.ts`
- Modify: `src/index.ts`
- Delete: `src/launcher.ts`
- Delete: `src/owned-index.ts`
- Delete: `test/launcher.test.ts`
- Modify: `scripts/smoke-packed-cli.mjs`

- [ ] **Step 1: Make the full `tools/list` parity gate green**

Run the owned server through `@modelcontextprotocol/client` and compare all 47 entries to `contracts/bevy-brp-mcp-0.22.3-tools.json` after `CONTRACT_OVERRIDES`. Compare name/title/description/annotations/input/output schema, not only names.

The allowed-difference map must contain only reviewed prose fields. Any schema/name/annotation difference fails.

- [ ] **Step 2: Parameterize the integration journey**

Before cutover, support two modes:

```text
upstream -> build/index.js + BEVY_BRP_MCP_BIN=bevy_brp_mcp
owned    -> build/owned-index.js
```

The same fixture/test code must run in both modes.

- [ ] **Step 3: Add differential response comparison**

For representative calls from every family, compare structured responses after a single normalization function. Preserve/compare `status`, `message`, `call_info`, parameters, results, error structure, guide content, watch semantics, and stable metadata. Normalize only nondeterministic PIDs, absolute temp paths, timestamps, and elapsed durations.

Required journey includes: list targets, launch, world query/get/mutate, resource get/mutate, spawn/despawn, name find, native watch + mutation + log observation + stop, single type guide, all-type guides representative inclusion, agent tools, `brp_execute` world_stats/time_control, diagnostics, set-window-title, screenshot, list/read logs, shutdown/process exit.

- [ ] **Step 4: Run both journeys before deleting the oracle**

```bash
npm run build
xvfb-run -a node scripts/integration.mjs --server upstream
xvfb-run -a node scripts/integration.mjs --server owned
xvfb-run -a node scripts/integration.mjs --server differential
```

Expected: all PASS.

- [ ] **Step 5: Cut over the actual package entrypoint**

Replace `src/index.ts` with the owned stdio entrypoint, delete `src/launcher.ts` and `src/owned-index.ts`, delete launcher unit tests, and keep the package bin path unchanged (`build/index.js`).

- [ ] **Step 6: Rewrite packed smoke around the owned server**

`npm pack`, install tarball in a temp directory, connect to the installed `bevy-plugin` with `StdioClientTransport`, assert all 47 tools are present, close client, and verify server exit. No fake/upstream executable.

- [ ] **Step 7: Run and commit**

```bash
npm run typecheck
npm run build
npm test
npm run smoke:packed
xvfb-run -a node scripts/integration.mjs --server owned
```

```bash
git add src test scripts
git rm src/launcher.ts src/owned-index.ts test/launcher.test.ts
git commit -m "feat: cut over to owned Bevy MCP server"
```

---

### Task 12: Remove final upstream dependency and finish docs/CI/package cleanup

**Files:**
- Create: `test/upstream-independence.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md` (and therefore `AGENTS.md` symlink behavior)
- Delete: `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`
- Delete: `docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md`
- Keep/package: `contracts/bevy-brp-mcp-0.22.3-tools.json`, `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Add one upstream-independence test only**

The test scans active runtime/build/config surfaces (`src`, active scripts, `.github`, package/plugin manifests, README/CLAUDE) and fails on executable dependency patterns:

```text
cargo install bevy_brp_mcp
BEVY_BRP_MCP_BIN
spawn/command of bevy_brp_mcp
```

Do not add a second scanner script or extra CI command for the same rule. The test ignores historical design docs, `THIRD_PARTY_NOTICES.md`, and the static contract fixture because those are reference/attribution data, not executable dependencies.

- [ ] **Step 2: Remove upstream from CI**

Delete the `cargo install bevy_brp_mcp --version 0.22.3 --locked` step and obsolete `/tmp/bevy_brp_mcp_*.log` dump. Integration runs only the owned server.

- [ ] **Step 3: Rewrite final README/CLAUDE guidance**

State that the npm package is the MCP server, there is no separate MCP Cargo prerequisite, watches use native BRP streams, the 47-tool contract is checked in/licensed, and the Rust bridge/extras remain app-side. Remove transitional launcher wording.

- [ ] **Step 4: Remove superseded September 3 architecture docs**

Delete the old spec/plan so agents see one current architecture.

- [ ] **Step 5: Inspect npm package contents**

Ensure `package.json.files` includes:

```text
build
contracts
THIRD_PARTY_NOTICES.md
plugin.json
mcp.json
```

Run:

```bash
npm pack --dry-run
```

Verify no external executable/vendor binary is required.

- [ ] **Step 6: Run every final gate on a no-upstream environment**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm ci
npm run typecheck
npm run build
npm test
npm run smoke:packed
xvfb-run -a node scripts/integration.mjs --server owned
```

Expected: all PASS without `bevy_brp_mcp` installed or invoked.

- [ ] **Step 7: Commit final migration cleanup**

```bash
git add .github package.json package-lock.json README.md CLAUDE.md test contracts THIRD_PARTY_NOTICES.md docs
git commit -m "docs: finish owned Bevy MCP migration"
```

---

## Final self-review checklist

- [ ] Captured source/version is exactly `bevy_brp_mcp` 0.22.3 / pinned commit and contains 47 default tools.
- [ ] `tools/list` parity covers name, title, description, annotations, input schema, and output schema.
- [ ] Reviewed contract overrides are prose-only and narrowly documented.
- [ ] Every tool advertises the upstream-compatible shared output schema.
- [ ] Every response includes `status`, `message`, and `call_info`; `result` is optional.
- [ ] Optional response fields (`metadata`, `parameters`, `error_info`, `brp_extras_debug_info`) are supported.
- [ ] No other handler calls `brp_execute` as fallback.
- [ ] Reflected Name path is `bevy_ecs::name::Name` and live-smoke verified.
- [ ] BRP watch tools consume native SSE streams; there is no polling/diff loop.
- [ ] Log tools expose filenames/app filters only and match captured parameter contracts.
- [ ] `LogStore` alone allocates/resolves app/watch paths.
- [ ] Spawned children are referenced and cleaned up after watches on server close.
- [ ] Cargo uses metadata + compiler artifacts and no custom freshness logic.
- [ ] Type guides include spawn examples, mutation paths, agent guidance, schema info, registry presence/errors, and curated Bevy type knowledge.
- [ ] Representative type-guide goldens match upstream before cutover.
- [ ] Unsafe parsed integers fail loudly.
- [ ] Differential upstream-vs-owned journey passes before launcher deletion.
- [ ] Final `src/index.ts` is owned server; launcher and `BEVY_BRP_MCP_BIN` are gone from active runtime.
- [ ] Final CI does not install upstream.
- [ ] One independence test exists; no duplicate scanner mechanism.
- [ ] Npm package includes contract fixture and attribution, not an upstream executable.
- [ ] Final owned integration passes on a machine with no upstream MCP installed.

## Execution handoff

Implementation continues on PR #3 / branch `agent/owned-bevy-mcp-server-plan`. Use subagent-driven development task-by-task with review after each commit. Do not split this migration into multiple PRs.