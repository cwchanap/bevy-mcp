# Owned Bevy MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `bevy_brp_mcp` launcher dependency with a complete TypeScript MCP server owned by this repository, exposing the full **47-tool default** Bevy MCP surface and passing a real Bevy fixture journey without the upstream executable installed.

**Architecture:** `@cwchanap/bevy-plugin` becomes the actual MCP stdio server using `@modelcontextprotocol/server` 2.x, the existing TypeScript 5.x compiler line, and Zod 4. One small BRP JSON-RPC client talks directly to each Bevy application's localhost BRP endpoint. Focused Node-native modules own Cargo discovery/build, process lifecycle, shared log paths, watches, type-guide generation, and composites. The existing Rust `bevy-mcp-bridge` remains the application-side provider of `BrpExtrasPlugin`, `bevy_mcp/world_stats`, and `bevy_mcp/time_control`.

**Tech Stack:** Node.js >=20, TypeScript `^5.3.3`, `@modelcontextprotocol/server` 2.x, `@modelcontextprotocol/client` 2.x for integration tests, Zod 4, native `fetch`, Node `child_process`/`fs`, Rust >=1.95, Bevy 0.19.x, `bevy_brp_extras` 0.22.3, GitHub Actions/Xvfb.

**Spec:** `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`

## Global Constraints

- This is one PR. Continue on branch `agent/owned-bevy-mcp-server-plan`; tasks below are review/commit boundaries, not separate PRs.
- Remove every runtime/build/install/subprocess dependency on `bevy_brp_mcp`.
- Upstream `natepiano/bevy_brp` commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b` is a migration reference only.
- Own exactly the 47 tools in the default upstream catalog. Do not add `brp_get_trace_log_path` or `brp_set_tracing_level`; upstream exposes them only under the non-default `mcp-debug` feature.
- `brp_execute` stays first-class; no other handler may call it as a fallback or shortcut.
- Keep `bevy_brp_extras = 0.22.3` in the Rust bridge. Do not reimplement extras inside the game plugin.
- Preserve default tool names and parameter intent from the pinned reference, then maintain local Zod/JSON-schema snapshots as the contract.
- Use `@modelcontextprotocol/server` for MCP framing/stdio.
- Keep TypeScript 5.x unless compilation with the server SDK proves a higher minimum is required; do not include a compiler-major migration in this PR.
- Use Zod 4. Known public contracts may not use a root `z.any()`, `z.unknown()`, or catch-all object as a substitute for real fields.
- Every structured tool result uses `{ message, result, metadata? }`.
- Default BRP port is 15702. Launch sets `BRP_EXTRAS_PORT` after merging user environment variables.
- Cargo launch always invokes Cargo build and relies on Cargo incremental compilation; do not port upstream freshness logic.
- Spawned Bevy children remain referenced. Server cleanup stops watches and tracked children before exiting.
- `LogStore` alone allocates app/watch log paths.
- No DB, daemon, persistent runtime state, DI framework, tool-codegen system, game-specific tools, WASM relay, or automatic project rewriting.
- `brp_all_type_guides` stays in parity without a new limit parameter. Its potentially large response is an accepted migration risk.

---

## Planned file structure

```text
src/
  index.ts
  server.ts
  services.ts
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
    shared.ts
    world.ts
    resources.ts
    discovery.ts
    agent-tools.ts
    extras.ts
    watches.ts
    app.ts
    logs.ts
    type-guides.ts
    schemas/
      common.ts
      world.ts
      extras.ts
      app.ts
      logs.ts
      type-guides.ts

test/
  server.test.ts
  catalog.test.ts
  schema-contracts.test.ts
  contracts/tool-schemas.json
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
  type-guides.test.ts
  app-tools.test.ts
  upstream-independence.test.ts

scripts/
  integration.mjs
  integration-name-smoke.mjs
  smoke-packed-cli.mjs
  check-no-upstream-runtime.mjs

fixtures/full-app/src/main.rs
package.json
package-lock.json
README.md
CLAUDE.md
AGENTS.md -> CLAUDE.md
.github/workflows/ci.yml
```

Delete during this PR:

```text
src/launcher.ts
test/launcher.test.ts
docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md
docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md
```

Plugin metadata remains structurally unchanged unless an ordinary package-version update requires edits.

---

## Parity contract

`test/catalog.test.ts` owns this exact list:

```ts
export const EXPECTED_TOOL_NAMES = [
  'world_list_components',
  'world_get_components',
  'world_despawn_entity',
  'world_insert_components',
  'world_remove_components',
  'world_list_resources',
  'world_get_resources',
  'world_insert_resources',
  'world_remove_resources',
  'world_mutate_resources',
  'world_mutate_components',
  'rpc_discover',
  'world_query',
  'world_find_entities_by_name',
  'world_spawn_entity',
  'world_trigger_event',
  'registry_schema',
  'world_reparent_entities',
  'world_get_components_watch',
  'world_list_components_watch',
  'brp_execute',
  'brp_list_agent_tools',
  'brp_extras_screenshot',
  'brp_extras_send_keys',
  'brp_extras_type_text',
  'brp_extras_set_window_title',
  'brp_extras_move_mouse',
  'brp_extras_send_mouse_button',
  'brp_extras_click_mouse',
  'brp_extras_double_click_mouse',
  'brp_extras_drag_mouse',
  'brp_extras_scroll_mouse',
  'brp_extras_pinch_gesture',
  'brp_extras_rotation_gesture',
  'brp_extras_double_tap_gesture',
  'brp_extras_get_diagnostics',
  'brp_stop_watch',
  'brp_list_active_watches',
  'brp_list_bevy',
  'brp_launch',
  'brp_shutdown',
  'brp_status',
  'brp_list_logs',
  'brp_read_log',
  'brp_delete_logs',
  'brp_type_guide',
  'brp_all_type_guides',
] as const;
```

The parameter source map is:

```text
world_list_components         -> ListComponentsParams
world_get_components          -> GetComponentsParams
world_despawn_entity          -> DespawnEntityParams
world_insert_components       -> InsertComponentsParams
world_remove_components       -> RemoveComponentsParams
world_list_resources          -> ListResourcesParams
world_get_resources           -> GetResourcesParams
world_insert_resources        -> InsertResourcesParams
world_remove_resources        -> RemoveResourcesParams
world_mutate_resources        -> MutateResourcesParams
world_mutate_components       -> MutateComponentsParams
rpc_discover                  -> RpcDiscoverParams
world_query                   -> QueryParams
world_find_entities_by_name   -> FindEntitiesByNameParams
world_spawn_entity            -> SpawnEntityParams
world_trigger_event           -> TriggerEventParams
registry_schema               -> RegistrySchemaParams
world_reparent_entities       -> ReparentEntitiesParams
world_get_components_watch    -> GetComponentsWatchParams
world_list_components_watch   -> ListComponentsWatchParams
brp_execute                   -> ExecuteParams
brp_list_agent_tools          -> ListAgentToolsParams
brp_extras_screenshot         -> ScreenshotParams
brp_extras_send_keys          -> SendKeysParams
brp_extras_type_text          -> TypeTextParams
brp_extras_set_window_title   -> SetWindowTitleParams
brp_extras_move_mouse         -> MoveMouseParams
brp_extras_send_mouse_button  -> SendMouseButtonParams
brp_extras_click_mouse        -> ClickMouseParams
brp_extras_double_click_mouse -> DoubleClickMouseParams
brp_extras_drag_mouse         -> DragMouseParams
brp_extras_scroll_mouse       -> ScrollMouseParams
brp_extras_pinch_gesture      -> PinchGestureParams
brp_extras_rotation_gesture   -> RotationGestureParams
brp_extras_double_tap_gesture -> DoubleTapGestureParams
brp_extras_get_diagnostics    -> GetDiagnosticsParams
brp_stop_watch                -> StopWatchParams
brp_list_bevy                 -> ListBevyParams
brp_launch                    -> LaunchBevyBinaryParams
brp_shutdown                  -> ShutdownParams
brp_status                    -> StatusParams
brp_list_logs                 -> ListLogsParams
brp_read_log                  -> ReadLogParams
brp_delete_logs               -> DeleteLogsParams
brp_type_guide                -> TypeGuideParams
brp_all_type_guides           -> AllTypeGuidesParams
```

Tools with no fields beyond default port use an explicit object schema rather than an untyped root.

---

### Task 1: Cut over the executable and pin the MCP result envelope

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/index.ts`
- Modify: `scripts/smoke-packed-cli.mjs`
- Create: `src/server.ts`
- Create: `src/services.ts`
- Create: `src/tools/register.ts`
- Create: `src/tools/shared.ts`
- Create: `test/server.test.ts`
- Delete: `src/launcher.ts`
- Delete: `test/launcher.test.ts`

**Interfaces:**

```ts
export interface ToolEnvelope<T = unknown, M extends Record<string, unknown> = Record<string, unknown>> {
  message: string;
  result: T;
  metadata?: M;
}

export function toolResult<T, M extends Record<string, unknown>>(
  envelope: ToolEnvelope<T, M>,
): CallToolResult;

export interface BevyMcpServices {
  brp: BrpClient;
  cargo: CargoRuntime;
  processes: ProcessManager;
  logs: LogStore;
  watches: WatchManager;
}

export function createServer(services: BevyMcpServices): McpServer;
```

- [ ] **Step 1: Write the failing server/result tests**

Create `test/server.test.ts` and assert:

```ts
const result = toolResult({
  message: 'Found 2 entities',
  result: [{ entity: 1 }, { entity: 2 }],
  metadata: { entity_count: 2 },
});

assert.deepEqual(result.structuredContent, {
  message: 'Found 2 entities',
  result: [{ entity: 1 }, { entity: 2 }],
  metadata: { entity_count: 2 },
});
assert.match(result.content[0].text, /Found 2 entities/);
```

Also assert `createServer(fakeServices())` performs no `child_process.spawn`.

Run:

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/server.test.js
```

Expected: FAIL because the local server/result helper does not exist.

- [ ] **Step 2: Add only the new runtime dependencies**

Keep the current compiler line:

```json
"dependencies": {
  "@modelcontextprotocol/server": "^2.0.0",
  "zod": "^4.2.0"
},
"devDependencies": {
  "@modelcontextprotocol/client": "^2.0.0",
  "@types/node": "^20.11.24",
  "typescript": "^5.3.3"
}
```

Run `npm install` to update the lockfile. Do not change TypeScript compiler options unless compilation requires a specific compatibility fix.

- [ ] **Step 3: Implement `toolResult()` and server bootstrap**

`toolResult()` always sets `structuredContent` to the envelope and emits one text content item using `message`.

`src/server.ts`:

```ts
export function createServer(services: BevyMcpServices) {
  const server = new McpServer({ name: 'bevy-mcp', version: '0.1.0' });
  registerTools(server, services);
  return server;
}
```

At this boundary `registerTools()` may be empty; later tasks fill it.

- [ ] **Step 4: Implement one idempotent cleanup path**

`src/index.ts` constructs services/server/stdio transport and defines:

```ts
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await services.watches.stopAll();
  await services.processes.shutdownAll();
  await server.close();
}
```

Register `shutdown()` for `SIGINT`, `SIGTERM`, and stdin/transport closure. Do not call `process.exit()` until cleanup completes.

- [ ] **Step 5: Delete the upstream launcher**

Delete `src/launcher.ts` and `test/launcher.test.ts`. Remove `PREREQUISITE_COMMAND`, `BEVY_BRP_MCP_BIN`, `launchUpstream`, and ENOENT installation guidance from active source.

- [ ] **Step 6: Rewrite packed smoke around a real MCP initialization**

`npm pack`, install the tarball in a temp directory, connect with `StdioClientTransport`, call `listTools()`, close the client, and verify the installed server exits without any fake/upstream binary.

- [ ] **Step 7: Run gates and commit**

```bash
npm run typecheck
npm run build
npm test
npm run smoke:packed
```

```bash
git add package.json package-lock.json src test scripts/smoke-packed-cli.mjs
git commit -m "feat: own MCP server bootstrap"
```

---

### Task 2: Implement the BRP JSON-RPC transport

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

export class BrpError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly port: number,
    readonly code?: number,
    readonly data?: unknown,
  );
}

export class BrpClient {
  call<T>(method: string, params?: unknown, options?: BrpCallOptions): Promise<T>;
  discover(port?: number): Promise<unknown>;
}
```

- [ ] **Step 1: Write failing tests against a local HTTP server**

Cover success, JSON-RPC error, malformed JSON, connection failure, caller abort, and timeout. Assert the body contains `jsonrpc: "2.0"`, numeric `id`, `method`, and `params` and targets `127.0.0.1` only.

- [ ] **Step 2: Implement native-fetch transport**

Use one `AbortController` per call, a timeout timer, and caller abort forwarding. Increment request IDs per client. Preserve BRP error `code/message/data`. Do not retry.

- [ ] **Step 3: Implement `discover()`**

```ts
return this.call('rpc.discover', {}, { port });
```

No cache in this PR.

- [ ] **Step 4: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/brp-client.test.js
npm run typecheck
```

```bash
git add src/brp src/services.ts test/brp-client.test.ts
git commit -m "feat: add local Bevy BRP client"
```

---

### Task 3: Add direct world/resource tools and local schema contracts

**Files:**
- Create: `src/tools/schemas/common.ts`
- Create: `src/tools/schemas/world.ts`
- Create: `src/tools/world.ts`
- Create: `src/tools/resources.ts`
- Create: `test/catalog.test.ts`
- Create: `test/world-tools.test.ts`
- Modify: `src/tools/register.ts`
- Modify: `src/tools/shared.ts`

**Interfaces:**

```ts
export const portSchema = z.number().int().min(1).max(65534).default(15702);

export function registerDirectBrpTool(
  server: McpServer,
  services: BevyMcpServices,
  definition: DirectBrpToolDefinition,
): void;
```

The helper parses args, removes only MCP-only `port`, calls the fixed registered BRP method, and returns `toolResult({ message, result, metadata })`.

- [ ] **Step 1: Add the green 47-name contract constant**

Copy `EXPECTED_TOOL_NAMES` from this plan into `test/catalog.test.ts` and initially assert only length/uniqueness:

```ts
assert.equal(EXPECTED_TOOL_NAMES.length, 47);
assert.equal(new Set(EXPECTED_TOOL_NAMES).size, 47);
```

- [ ] **Step 2: Transcribe direct core parameter structs into Zod**

Use the pinned parameter map. Preserve required fields, serialized names, optional/null behavior, nested `data` objects, port default 15702, safe non-negative entity IDs, and port range `1..65534`.

Add valid/invalid `safeParse()` coverage for every schema group. Do not use a root catch-all.

- [ ] **Step 3: Register fixed world mappings**

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
```

- [ ] **Step 4: Register fixed resource mappings**

```ts
const RESOURCE_DIRECT = {
  world_list_resources: 'world.list_resources',
  world_get_resources: 'world.get_resources',
  world_insert_resources: 'world.insert_resources',
  world_remove_resources: 'world.remove_resources',
  world_mutate_resources: 'world.mutate_resources',
} as const;
```

- [ ] **Step 5: Test exact mapping and envelope behavior**

For every direct mapping assert correct BRP method, selected port, absence of `port` in forwarded params, BRP payload under `structuredContent.result`, stable `message`, and tool-error conversion.

- [ ] **Step 6: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/catalog.test.js \
  .test-build/test/world-tools.test.js
npm run typecheck
```

```bash
git add src/tools test/catalog.test.ts test/world-tools.test.ts
git commit -m "feat: add core Bevy world tools"
```

---

### Task 4: Implement name discovery, agent tools, type guides, and the parity fixture early

**Files:**
- Modify: `fixtures/full-app/src/main.rs`
- Create: `scripts/integration-name-smoke.mjs`
- Create: `src/tools/discovery.ts`
- Create: `src/tools/agent-tools.ts`
- Create: `src/tools/type-guides.ts`
- Create: `src/tools/schemas/type-guides.ts`
- Create: `test/discovery-tools.test.ts`
- Create: `test/type-guides.test.ts`
- Modify: `src/tools/register.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export type NameMatchMode = 'exact' | 'prefix' | 'suffix' | 'contains';

export function findEntitiesByName(
  services: BevyMcpServices,
  input: { name: string; match_mode?: NameMatchMode; port?: number },
): Promise<Array<{ entity: number; name: string }>>;
```

- [ ] **Step 1: Expand the fixture before mocking the composite**

Add and register:

```rust
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct FixtureValue {
    value: i32,
}
```

Spawn a visible entity with:

```rust
(
    Name::new("FixturePrimary"),
    FixtureMarker,
    FixtureValue { value: 1 },
    // existing mesh/material/transform
)
```

Keep `FixtureState` and add `counter: i32` for later resource mutation integration.

- [ ] **Step 2: Write name-resolution tests using the correct reflected type**

The query component path is exactly:

```text
bevy_ecs::name::Name
```

Test default exact mode, exact/prefix/suffix/contains, case sensitivity, literal `*`, ascending entity order, empty results, and malformed/non-string Name payload errors.

- [ ] **Step 3: Implement `world_find_entities_by_name`**

Issue one `world.query` with both:

```json
{
  "data": { "components": ["bevy_ecs::name::Name"] },
  "filter": { "with": ["bevy_ecs::name::Name"] }
}
```

Read each returned component value as a string, matching Bevy 0.19's observed wire shape, then filter locally. Do not call `brp_execute`.

- [ ] **Step 4: Add a live name smoke before proceeding**

`scripts/integration-name-smoke.mjs` builds/starts the fixture directly with `BRP_EXTRAS_PORT=15702`, waits for `rpc.discover`, calls the local `world_find_entities_by_name` MCP tool, asserts exactly one `FixturePrimary`, then terminates the fixture.

Add:

```json
"test:integration:name": "npm run build && node scripts/integration-name-smoke.mjs"
```

On Linux/CI invoke it under Xvfb. This prevents a mocked Name contract from surviving until the final E2E task.

- [ ] **Step 5: Implement `brp_execute` with discovery validation**

Call `rpc.discover` first, reject unknown methods, then call the requested method directly through `BrpClient`. No other module imports the handler.

- [ ] **Step 6: Implement `brp_list_agent_tools`**

Call `brp_extras/agent_tools` and preserve `name`, `method`, `description`, `params_schema`, and `result_schema`. Unit-test `bevy_mcp_world_stats` and `bevy_mcp_time_control` fixtures.

- [ ] **Step 7: Implement both type-guide tools**

`brp_type_guide` transforms one requested registered type. `brp_all_type_guides` preserves the default upstream port-only public contract and returns the complete compatible guide set. Use shared pure transformation functions and avoid N redundant registry fetches.

Test struct component, resource, enum, nested reference, required fields, and non-constructible schema cases.

- [ ] **Step 8: Run and commit**

```bash
cargo test --workspace
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/discovery-tools.test.js \
  .test-build/test/type-guides.test.js
xvfb-run -a npm run test:integration:name
```

```bash
git add fixtures scripts package.json src/tools test
git commit -m "feat: add Bevy discovery and type tools"
```

---

### Task 5: Implement the complete extras family

**Files:**
- Create: `src/tools/schemas/extras.ts`
- Create: `src/tools/extras.ts`
- Create: `test/extras-tools.test.ts`
- Modify: `src/tools/register.ts`

- [ ] **Step 1: Transcribe extras schemas into Zod**

Cover `ScreenshotParams`, keys, text, window title, mouse operations, gestures, and diagnostics. Preserve selector/coordinate/button/text/path requirements and port default.

- [ ] **Step 2: Register 13 direct extras mappings**

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

- [ ] **Step 3: Test screenshot modes**

Cover full, camera-only, entity, exact-name unique match, `entity+name` rejection, padding-without-selector rejection, zero-name matches, and duplicate-name candidate IDs.

- [ ] **Step 4: Implement screenshot composite**

Name mode calls `findEntitiesByName(..., match_mode: 'exact')`, resolves exactly one entity, then calls `brp_extras/screenshot`. Never call `brp_execute`.

- [ ] **Step 5: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/extras-tools.test.js
```

```bash
git add src/tools test/extras-tools.test.ts
git commit -m "feat: add Bevy extras MCP tools"
```

---

### Task 6: Make LogStore the single path owner and add watches

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
  createAppLog(input: { targetName: string; port: number }): Promise<string>;
  createWatchLog(input: { entity: number; kind: string; port: number }): Promise<string>;
  list(): Promise<LogEntry[]>;
  read(path: string, options: ReadLogOptions): Promise<string>;
  delete(paths?: string[]): Promise<number>;
}

export interface ActiveWatch {
  id: number;
  kind: 'get_components' | 'list_components';
  entity: number;
  types?: string[];
  port: number;
  startedAt: string;
  logPath: string;
}
```

- [ ] **Step 1: Implement LogStore containment first**

Owned root:

```text
<tmp>/bevy-mcp/apps/
<tmp>/bevy-mcp/watches/
```

Test sanitized filenames, canonical containment, bounded full/tail reads, list metadata, deletes, `../` rejection, and absolute external path rejection.

- [ ] **Step 2: Write WatchManager tests with injected LogStore**

IDs start at 1 and increase monotonically. Initial read must succeed before registration. Empty `types` fails. Unchanged snapshots do not re-log. Changed snapshots append one event. Stop/list/stopAll behavior is deterministic.

- [ ] **Step 3: Implement watch polling**

`WatchManager` asks `LogStore.createWatchLog()` for the path and never constructs a temp path itself. Production interval 250 ms; tests inject 5 ms. Use a small stable recursive object-key sort only for snapshot equality.

- [ ] **Step 4: Register four watch tools**

- `world_get_components_watch`
- `world_list_components_watch`
- `brp_list_active_watches`
- `brp_stop_watch`

Start results use the shared envelope with `watch_id`/`log_path` in metadata.

- [ ] **Step 5: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/log-store.test.js \
  .test-build/test/watch-manager.test.js \
  .test-build/test/watch-tools.test.js
```

```bash
git add src/runtime src/tools src/services.ts test
git commit -m "feat: own Bevy watch and log paths"
```

---

### Task 7: Implement Cargo target discovery and build artifact resolution

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
  build(request: { target: BevyTarget; profile: 'debug' | 'release' }): Promise<{ executable: string }>;
}
```

- [ ] **Step 1: Test metadata normalization with fixture JSON**

Cover workspace bins/examples, duplicate names in separate packages, non-binary targets, and path scoping.

- [ ] **Step 2: Implement `listTargets()`**

Resolve directory/Cargo.toml input and run:

```bash
cargo metadata --format-version 1 --no-deps --manifest-path <manifest>
```

Sort by kind, package, name.

- [ ] **Step 3: Add a real metadata test against this repository**

Call `listTargets(repoRoot)` and assert the real `bevy-mcp-fixture` binary is discovered with its package/manifest metadata. This is the first real Cargo-path gate, not deferred to final E2E.

- [ ] **Step 4: Test and implement Cargo JSON artifact parsing**

Use:

```text
cargo build --message-format=json-render-diagnostics --manifest-path <manifest> --package <pkg> --bin <name>
```

or `--example <name>`, with `--release` only when requested. Select the matching `compiler-artifact.executable`; never predict `target/` paths.

- [ ] **Step 5: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/cargo.test.js
```

```bash
git add src/runtime/cargo.ts src/services.ts test/cargo.test.ts
git commit -m "feat: own Cargo target discovery"
```

---

### Task 8: Implement process lifecycle, app tools, and log tools

**Files:**
- Create: `src/runtime/process-manager.ts`
- Create: `src/tools/schemas/app.ts`
- Create: `src/tools/schemas/logs.ts`
- Create: `src/tools/app.ts`
- Create: `src/tools/logs.ts`
- Create: `test/process-manager.test.ts`
- Create: `test/app-tools.test.ts`
- Create: `test/log-tools.test.ts`
- Modify: `src/index.ts`
- Modify: `src/services.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**

```ts
export interface TrackedProcess {
  pid: number;
  targetName: string;
  packageName: string;
  kind: 'app' | 'example';
  port: number;
  profile: 'debug' | 'release';
  startedAt: string;
  logPath: string;
}

export class ProcessManager {
  launch(input: LaunchProcessInput): Promise<TrackedProcess>;
  list(): TrackedProcess[];
  shutdown(input: ShutdownProcessInput): Promise<ShutdownResult>;
  shutdownAll(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle tests before spawning implementation**

Assert children are not `unref()`ed, app log paths are supplied by `LogStore`, `BRP_EXTRAS_PORT` overrides user env, exit removes tracking, shutdown tries BRP first then ordinary process termination after a bounded wait, and `shutdownAll()` clears every tracked child.

- [ ] **Step 2: Implement `ProcessManager.launch()`**

Receive an already-built executable and a `LogStore`-created path. Spawn with stdout/stderr redirected to that file and keep the child referenced/tracked.

Environment order:

```text
process.env < user env < BRP_EXTRAS_PORT=<assigned port>
```

- [ ] **Step 3: Implement `brp_list_bevy` and `brp_launch`**

Resolve path, search order, optional package disambiguation, consecutive port range, one Cargo build, `instance_count` spawns, and envelope metadata containing PIDs/ports/log paths/target/package/profile.

- [ ] **Step 4: Implement `brp_status` and `brp_shutdown`**

Status combines tracked-process state with live `rpc.discover` readiness. Shutdown calls `brp_extras/shutdown`, waits, then terminates the still-running tracked child if necessary.

- [ ] **Step 5: Implement only the three default log tools**

- `brp_list_logs`
- `brp_read_log`
- `brp_delete_logs`

They operate only through `LogStore`; there is no TraceLogger or public trace tool.

- [ ] **Step 6: Wire process cleanup into server shutdown**

Verify `src/index.ts` cleanup order is:

```text
watches.stopAll()
-> processes.shutdownAll()
-> server.close()
```

and is triggered on signals plus stdio/client closure.

- [ ] **Step 7: Run and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/process-manager.test.js \
  .test-build/test/app-tools.test.js \
  .test-build/test/log-tools.test.js
```

```bash
git add src test
git commit -m "feat: own Bevy app lifecycle and logs"
```

---

### Task 9: Complete exact registration and freeze local schema snapshots

**Files:**
- Modify: `src/tools/register.ts`
- Modify: `test/catalog.test.ts`
- Create: `test/schema-contracts.test.ts`
- Create: `test/contracts/tool-schemas.json`

- [ ] **Step 1: Register every domain exactly once**

```ts
export function registerTools(server: McpServer, services: BevyMcpServices) {
  registerWorldTools(server, services);
  registerResourceTools(server, services);
  registerDiscoveryTools(server, services);
  registerAgentTools(server, services);
  registerExtrasTools(server, services);
  registerWatchTools(server, services);
  registerAppTools(server, services);
  registerLogTools(server, services);
  registerTypeGuideTools(server, services);
}
```

- [ ] **Step 2: Make the exact 47-name gate green**

Record names through real `registerTools()` and assert length 47, uniqueness 47, and sorted equality with `EXPECTED_TOOL_NAMES`.

- [ ] **Step 3: Snapshot every public input schema locally**

Generate JSON Schema from each Zod contract using Zod 4 and write a deterministic object keyed by tool name to `test/contracts/tool-schemas.json` once during implementation. `test/schema-contracts.test.ts` regenerates in memory and deep-compares to the committed snapshot.

The snapshot contains only local contract data; tests never fetch upstream.

- [ ] **Step 4: Add MCP annotations**

Read-only for list/get/query/discover/status/log-read/type-guide/diagnostics; destructive for despawn/remove/delete/shutdown/stop; non-idempotent for spawn/events/input/launch; mutating idempotent where repeated input has the same effect.

- [ ] **Step 5: Run and commit**

```bash
npm test
npm run typecheck
npm run build
```

```bash
git add src test
git commit -m "test: freeze Bevy MCP tool contracts"
```

---

### Task 10: Replace upstream-based integration with the full owned journey

**Files:**
- Modify: `scripts/integration.mjs`
- Modify: `package.json` only if script flags change

- [ ] **Step 1: Remove all upstream assumptions**

Delete checks/comments/env handling for `bevy_brp_mcp` or `BEVY_BRP_MCP_BIN`. Start `build/index.js` directly through `StdioClientTransport`.

- [ ] **Step 2: Assert all 47 tools before launch**

`client.listTools()` must exactly match `EXPECTED_TOOL_NAMES` (duplicate-safe and order-independent).

- [ ] **Step 3: Exercise representative real behavior from every domain**

Required journey:

```text
MCP initialize
-> list 47 tools
-> brp_list_bevy finds bevy-mcp-fixture
-> brp_launch on test port
-> world_list_components
-> world_query FixtureMarker
-> world_get_components FixtureValue
-> world_mutate_components FixtureValue.value
-> world_get_resources FixtureState
-> world_mutate_resources FixtureState.counter
-> world_spawn_entity
-> world_despawn_entity spawned ID
-> world_find_entities_by_name FixturePrimary
-> world_get_components_watch
-> mutate FixtureValue again
-> observe watch log change
-> brp_stop_watch
-> brp_type_guide FixtureValue
-> brp_all_type_guides returns a non-empty complete result
-> brp_list_agent_tools validates world_stats/time_control schemas
-> brp_execute bevy_mcp/world_stats
-> brp_execute bevy_mcp/time_control pause/resume
-> brp_extras_get_diagnostics
-> brp_extras_set_window_title
-> brp_extras_screenshot to temp PNG
-> brp_list_logs + brp_read_log
-> brp_shutdown
-> verify launched PID exits
```

Use `eventually()` only for app readiness, watch observation, and process exit.

- [ ] **Step 4: Verify server-close cleanup separately**

Launch a second fixture instance through MCP, close the MCP client without explicitly calling `brp_shutdown`, and assert the tracked Bevy PID exits. This pins the no-orphan contract.

- [ ] **Step 5: Run and commit**

```bash
cargo build -p bevy-mcp-fixture
npm run build
xvfb-run -a npm run test:integration
```

```bash
git add scripts/integration.mjs package.json
git commit -m "test: cover owned Bevy MCP end to end"
```

---

### Task 11: Enforce upstream independence and finish repository migration

**Files:**
- Create: `scripts/check-no-upstream-runtime.mjs`
- Create: `test/upstream-independence.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Verify: `AGENTS.md` symlink resolves to updated `CLAUDE.md`
- Delete: `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`
- Delete: `docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md`

- [ ] **Step 1: Add the independence scanner**

Scan active code/config/guidance roots including:

```js
const roots = [
  'src', 'test', 'scripts', '.github', 'plugins',
  'package.json', 'package-lock.json', 'mcp.json', 'plugin.json',
  'README.md', 'CLAUDE.md', 'AGENTS.md',
];
```

Fail on active dependency patterns such as `cargo install bevy_brp_mcp`, `BEVY_BRP_MCP_BIN`, or spawning/commanding `bevy_brp_mcp`. The new design/plan may mention the removed dependency historically, so `docs/superpowers` is excluded.

- [ ] **Step 2: Fix CI completely, not only the install step**

Delete the upstream Cargo install step **and** the stale failure diagnostic that scans `/tmp/bevy_brp_mcp_*.log`. On integration failure, dump only files under the owned `<tmp>/bevy-mcp/` root when present.

Add `npm run check:no-upstream` before integration.

- [ ] **Step 3: Rewrite README**

Document the npm package as the MCP server, Node/Rust + `BevyMcpPlugin` prerequisites, no separate MCP Cargo install, 47-tool categories, app-side extras, automatic launch port env, and current development commands.

- [ ] **Step 4: Finalize `CLAUDE.md` / `AGENTS.md` guidance**

Remove all instructions saying the repo must not implement an MCP server or BRP/Cargo/process layers. Replace with the owned-server architecture, one-PR workflow, local contract snapshots, and command list. Because `AGENTS.md` is a symlink, verify it resolves to the same updated guidance instead of creating a divergent second file.

- [ ] **Step 5: Delete superseded September 3 docs**

Leave one current architecture story: the September 7 owned-server spec + plan.

- [ ] **Step 6: Run every final gate**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm ci
npm run check:no-upstream
npm run typecheck
npm run build
npm test
npm run smoke:packed
xvfb-run -a npm run test:integration:name
xvfb-run -a npm run test:integration
npm pack --dry-run
```

Expected: all PASS on a machine without `bevy_brp_mcp` installed.

- [ ] **Step 7: Commit final migration**

```bash
git add .github package.json package-lock.json README.md CLAUDE.md scripts test docs
git commit -m "docs: finish owned Bevy MCP migration"
```

---

## Per-task review rule

After each task commit, review that commit/diff before starting the next task. This does **not** create multiple PRs; it keeps one large migration reviewable while honoring the one-task/one-PR delivery rule.

## Final self-review checklist

- [ ] Exactly 47 default public MCP tools are registered.
- [ ] The two non-default upstream `mcp-debug` trace tools are intentionally absent.
- [ ] Every known public input contract has a Zod schema and committed JSON-schema snapshot.
- [ ] Every structured result uses `{ message, result, metadata? }`.
- [ ] No handler except `brp_execute` accepts a dynamic BRP method.
- [ ] No handler calls `brp_execute` as a fallback.
- [ ] Name lookup uses `bevy_ecs::name::Name` and passes a live fixture smoke.
- [ ] Screenshot-by-name is a real composite.
- [ ] Watch IDs are monotonic numeric IDs.
- [ ] LogStore allocates every app/watch log path.
- [ ] Watches stop on server shutdown.
- [ ] Cargo uses metadata + compiler artifacts and passes a real workspace metadata test.
- [ ] Spawned children are not unref'd.
- [ ] Server close kills/shuts down tracked Bevy processes.
- [ ] Log tools are restricted to the owned temp root.
- [ ] `brp_all_type_guides` remains available with its default parity contract.
- [ ] TypeScript stays on the 5.x line unless the SDK proves otherwise.
- [ ] Packed smoke performs real MCP initialization.
- [ ] Full integration starts `build/index.js` directly.
- [ ] CI never installs or invokes `bevy_brp_mcp` and contains no stale upstream temp-log diagnostics.
- [ ] README and CLAUDE/AGENTS guidance describe the owned server.
- [ ] Old upstream-delegation design/plan are removed.

## Execution handoff

Implementation continues on `agent/owned-bevy-mcp-server-plan` so the approved design, plan, and code land in one PR. Use subagent-driven development task-by-task with TDD and review between task commits; do not split the migration into multiple PRs.
