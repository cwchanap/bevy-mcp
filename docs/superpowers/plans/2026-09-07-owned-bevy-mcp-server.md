# Owned Bevy MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `bevy_brp_mcp` launcher dependency with a complete TypeScript MCP server owned by this repository, exposing the full 49-tool Bevy MCP surface and passing a real Bevy fixture journey without the upstream executable installed.

**Architecture:** `@cwchanap/bevy-plugin` becomes the actual MCP stdio server using `@modelcontextprotocol/server` 2.x and Zod 4. One small BRP JSON-RPC client talks directly to each Bevy application's localhost BRP endpoint, while focused Node-native runtime modules own Cargo discovery/build/launch, process tracking, logs/tracing, watches, type-guide generation, and composite tools. The existing Rust `bevy-mcp-bridge` remains the application-side provider of `BrpExtrasPlugin`, `bevy_mcp/world_stats`, and `bevy_mcp/time_control`.

**Tech Stack:** Node.js >=20, TypeScript 7.0.x, `@modelcontextprotocol/server` 2.x, `@modelcontextprotocol/client` 2.x for integration tests, Zod 4, native `fetch`, Node `child_process`/`fs`, Rust >=1.95, Bevy 0.19.x, `bevy_brp_extras` 0.22.3, GitHub Actions/Xvfb.

**Spec:** `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`

## Global Constraints

- This task is one PR. Continue implementation on branch `agent/owned-bevy-mcp-server-plan`; do not create one PR per task below.
- Remove every runtime/build/install/subprocess dependency on `bevy_brp_mcp`.
- Upstream `natepiano/bevy_brp` commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b` is pinned only as the behavioral/schema reference used to define parity during implementation.
- Own all 49 tools listed in the spec, including `brp_get_trace_log_path` and `brp_set_tracing_level` as normal always-present TypeScript tools.
- `brp_execute` remains a first-class explicit tool, but no other handler may call it as a fallback or shortcut.
- Keep `bevy_brp_extras = 0.22.3` in the Rust bridge; this task removes the upstream MCP server, not the application-side extras plugin.
- Preserve tool names and parameter intent from the pinned upstream registry; internal source layout and implementation details may change freely.
- Use `@modelcontextprotocol/server` for MCP protocol/stdio; do not implement MCP framing.
- Use Zod 4 schemas; do not use a root `z.any()`, `z.unknown()`, or catch-all schema as a substitute for a known public tool contract.
- Default BRP port is 15702. Launch sets `BRP_EXTRAS_PORT` for each spawned app instance.
- Cargo launch always invokes Cargo build and relies on Cargo incremental compilation; do not port upstream's custom build-freshness subsystem.
- No database, daemon, persistent process/watch state, DI framework, generic plugin framework, or Rust-style macro/codegen layer.
- No game-specific tools, WASM relay, remote-network discovery, or automatic consumer-project rewriting.
- Rust bridge behavior (`world_stats`, `time_control`) remains unchanged unless fixture/test support requires a narrowly scoped edit.

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
    trace-logger.ts
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
  smoke-packed-cli.mjs
  check-no-upstream-runtime.mjs

fixtures/full-app/src/main.rs
package.json
package-lock.json
README.md
.github/workflows/ci.yml
```

Delete during this PR:

```text
src/launcher.ts
test/launcher.test.ts
docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md
docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md
```

Keep plugin metadata (`mcp.json`, `plugin.json`, `plugins/bevy-plugin/**`, marketplace files) structurally unchanged unless package versioning requires an ordinary version bump.

---

## Parity contract

The following public catalog is the PR's non-negotiable tool-list gate.

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
  'brp_get_trace_log_path',
  'brp_set_tracing_level',
  'brp_type_guide',
  'brp_all_type_guides',
] as const;
```

For parameter/schema parity, use the pinned upstream registry and matching parameter structs as the fixed source of truth. The implementation must transcribe those Rust structs into Zod rather than consuming the upstream crate/package. Important mappings:

```text
world_list_components        -> ListComponentsParams
world_get_components         -> GetComponentsParams
world_despawn_entity         -> DespawnEntityParams
world_insert_components      -> InsertComponentsParams
world_remove_components      -> RemoveComponentsParams
world_list_resources         -> ListResourcesParams
world_get_resources          -> GetResourcesParams
world_insert_resources       -> InsertResourcesParams
world_remove_resources       -> RemoveResourcesParams
world_mutate_resources       -> MutateResourcesParams
world_mutate_components      -> MutateComponentsParams
rpc_discover                 -> RpcDiscoverParams
world_query                  -> QueryParams
world_find_entities_by_name  -> FindEntitiesByNameParams
world_spawn_entity           -> SpawnEntityParams
world_trigger_event          -> TriggerEventParams
registry_schema              -> RegistrySchemaParams
world_reparent_entities      -> ReparentEntitiesParams
world_get_components_watch   -> GetComponentsWatchParams
world_list_components_watch  -> ListComponentsWatchParams
brp_execute                  -> ExecuteParams
brp_list_agent_tools         -> ListAgentToolsParams
brp_extras_screenshot        -> ScreenshotParams
brp_extras_send_keys         -> SendKeysParams
brp_extras_type_text         -> TypeTextParams
brp_extras_set_window_title  -> SetWindowTitleParams
brp_extras_move_mouse        -> MoveMouseParams
brp_extras_send_mouse_button -> SendMouseButtonParams
brp_extras_click_mouse       -> ClickMouseParams
brp_extras_double_click_mouse -> DoubleClickMouseParams
brp_extras_drag_mouse        -> DragMouseParams
brp_extras_scroll_mouse      -> ScrollMouseParams
brp_extras_pinch_gesture     -> PinchGestureParams
brp_extras_rotation_gesture  -> RotationGestureParams
brp_extras_double_tap_gesture -> DoubleTapGestureParams
brp_extras_get_diagnostics   -> GetDiagnosticsParams
brp_list_bevy                -> ListBevyParams
brp_launch                   -> LaunchBevyBinaryParams
brp_shutdown                 -> ShutdownParams
brp_status                   -> StatusParams
brp_list_logs                -> ListLogsParams
brp_read_log                 -> ReadLogParams
brp_delete_logs              -> DeleteLogsParams
brp_stop_watch               -> StopWatchParams
brp_set_tracing_level        -> SetTracingLevelParams
brp_type_guide               -> TypeGuideParams
brp_all_type_guides          -> AllTypeGuidesParams
```

When upstream has no parameter struct (`brp_list_active_watches`, `brp_get_trace_log_path`, etc.), expose an empty Zod object rather than an untyped schema.

---

### Task 1: Cut over the npm executable to a real MCP server

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
- Produces `BevyMcpServices` as a plain object of runtime collaborators.
- Produces `createServices(): BevyMcpServices`.
- Produces `createServer(services?: BevyMcpServices): McpServer`.
- Produces `registerTools(server: McpServer, services: BevyMcpServices): void`.
- `src/index.ts` owns `StdioServerTransport` connection and signal cleanup only.

- [ ] **Step 1: Replace launcher tests with a failing MCP server construction test**

Create `test/server.test.ts` with a test that imports `createServer`, asserts it returns an MCP server instance, and verifies server construction uses only injected services. Use a fake `BevyMcpServices` object so the test has no Cargo/BRP dependency.

```ts
const services: BevyMcpServices = {
  brp: fakeBrpClient(),
  cargo: fakeCargoRuntime(),
  processes: fakeProcessManager(),
  logs: fakeLogStore(),
  trace: fakeTraceLogger(),
  watches: fakeWatchManager(),
};

const server = createServer(services);
assert.ok(server);
```

Run:

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/server.test.js
```

Expected: FAIL because `server.ts` / `services.ts` do not exist.

- [ ] **Step 2: Update dependencies to the owned server stack**

`package.json` becomes:

```json
"dependencies": {
  "@modelcontextprotocol/server": "^2.0.0",
  "zod": "^4.0.0"
},
"devDependencies": {
  "@modelcontextprotocol/client": "^2.0.0",
  "@types/node": "^20.11.24",
  "typescript": "^7.0.2"
}
```

Use `npm install` so `package-lock.json` records exact resolved versions. Keep Node >=20 and existing build/test scripts unless a TypeScript 7 compiler option needs a direct migration.

- [ ] **Step 3: Implement the MCP bootstrap**

`src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { createServices, type BevyMcpServices } from './services.js';
import { registerTools } from './tools/register.js';

export function createServer(services: BevyMcpServices = createServices()) {
  const server = new McpServer({ name: 'bevy-mcp', version: '0.1.0' });
  registerTools(server, services);
  return server;
}
```

`src/index.ts` becomes:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { createServices } from './services.js';

const services = createServices();
const server = createServer(services);
const transport = new StdioServerTransport();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await services.watches.stopAll();
    await server.close();
    process.exit(0);
  });
}

await server.connect(transport);
```

At this task boundary `registerTools()` may register zero tools while later domain implementations are absent, but the executable must already be a valid local MCP server and must never spawn an upstream server.

- [ ] **Step 4: Delete launcher delegation code**

Delete `src/launcher.ts` and `test/launcher.test.ts`. Remove `PREREQUISITE_COMMAND`, `BEVY_BRP_MCP_BIN`, `launchUpstream`, and all ENOENT install guidance from source.

- [ ] **Step 5: Rewrite the packed CLI smoke test around MCP initialization**

Replace the fake-upstream executable flow in `scripts/smoke-packed-cli.mjs` with:

1. `npm pack` into a temp directory;
2. install the tarball there;
3. use the repo's `@modelcontextprotocol/client` to spawn the installed `node_modules/.bin/bevy-plugin`;
4. `client.connect()` successfully;
5. `client.listTools()` returns an array (possibly empty at this task boundary);
6. `client.close()` causes the packed server process to exit cleanly;
7. assert no `BEVY_BRP_MCP_BIN` or fake executable is involved.

Core transport:

```js
const transport = new StdioClientTransport({
  command: path.join(tmpDir, 'node_modules', '.bin', 'bevy-plugin'),
  cwd: tmpDir,
  stderr: 'inherit',
  env: { ...process.env },
});
await client.connect(transport);
assert.ok(Array.isArray((await client.listTools()).tools));
await client.close();
```

- [ ] **Step 6: Run server/package gates**

```bash
npm run typecheck
npm run build
npm test
npm run smoke:packed
```

Expected: PASS; packed CLI initializes the local Node MCP server.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Write transport tests against a local HTTP server**

Cover:

```ts
assert.deepEqual(await client.call('world.query', { data: {} }, { port }), expectedResult);
await assert.rejects(() => client.call('world.query', {}, { port }), BrpError);
await assert.rejects(() => client.call('world.query', {}, { port: malformedPort }), /invalid JSON/i);
await assert.rejects(() => client.call('world.query', {}, { port: slowPort, timeoutMs: 10 }), /timed out/i);
```

Also assert the request body contains exactly `jsonrpc`, numeric `id`, `method`, and `params` and targets `http://127.0.0.1:<port>`.

Run and verify FAIL.

- [ ] **Step 2: Implement `BrpClient` with native fetch**

Use an `AbortController` plus timer for timeout and combine a caller signal by forwarding its abort into the controller. Increment request IDs per client instance. Preserve JSON-RPC `error.code`, `error.message`, and `error.data` in `BrpError`.

Do not retry connection failures.

- [ ] **Step 3: Implement `discover()`**

```ts
return this.call('rpc.discover', {}, { port });
```

No caching in this PR.

- [ ] **Step 4: Wire the concrete client into `createServices()` and run tests**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/brp-client.test.js
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brp src/services.ts test/brp-client.test.ts
git commit -m "feat: add local Bevy BRP client"
```

---

### Task 3: Add the parity fixture and direct world/resource tools

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

export function registerDirectBrpTool<T extends z.ZodType>(
  server: McpServer,
  services: BevyMcpServices,
  definition: {
    name: string;
    description: string;
    method: string;
    schema: T;
    annotations?: ToolAnnotations;
  },
): void;
```

The helper parses MCP args, removes only the MCP-only `port` field, calls `services.brp.call(method, brpParams, { port })`, and returns structured content. It must not accept a method dynamically at call time.

- [ ] **Step 1: Add a green parity-list fixture test**

Copy `EXPECTED_TOOL_NAMES` from this plan into `test/catalog.test.ts` and assert only the contract itself initially:

```ts
assert.equal(EXPECTED_TOOL_NAMES.length, 49);
assert.equal(new Set(EXPECTED_TOOL_NAMES).size, 49);
```

Task 8 will extend this same test to compare the actual registered server tool names. Do not leave a deliberately red catalog test across multiple tasks.

- [ ] **Step 2: Transcribe direct core parameter structs into Zod**

Use pinned upstream commit `85d0eca...` and the parameter-type map in this plan. For every schema:

- make required Rust fields required in Zod;
- preserve serialized field names such as `target_name`/`package_name`;
- preserve optional/null semantics;
- default `port` to 15702;
- validate entity IDs as non-negative safe integers;
- validate ports 1..65534;
- preserve nested BRP `data` objects exactly where the public MCP contract uses them;
- reject missing required arrays/objects rather than silently sending empty values.

Add one `safeParse` valid case and one invalid case per schema group. Do not use root catch-all schemas.

- [ ] **Step 3: Register direct world tools**

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

`world_find_entities_by_name` and both watch tools remain explicit composites for later tasks.

- [ ] **Step 4: Register direct resource tools**

```ts
const RESOURCE_DIRECT = {
  world_list_resources: 'world.list_resources',
  world_get_resources: 'world.get_resources',
  world_insert_resources: 'world.insert_resources',
  world_remove_resources: 'world.remove_resources',
  world_mutate_resources: 'world.mutate_resources',
} as const;
```

- [ ] **Step 5: Test exact BRP mappings**

Use a fake `BrpClient` recording calls. For every mapping above, call the registered handler with valid minimal parameters and assert:

- MCP `port` is not present in BRP params;
- correct BRP method is used;
- selected port is passed to `BrpClient`;
- BRP result becomes `structuredContent`;
- BRP errors become MCP tool errors rather than crashing the server.

- [ ] **Step 6: Run domain tests and commit**

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

### Task 4: Implement discovery composites, agent tools, and type guides

**Files:**
- Create: `src/tools/discovery.ts`
- Create: `src/tools/agent-tools.ts`
- Create: `src/tools/type-guides.ts`
- Create: `src/tools/schemas/type-guides.ts`
- Create: `test/discovery-tools.test.ts`
- Create: `test/type-guides.test.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**

```ts
export type NameMatchMode = 'exact' | 'prefix' | 'suffix' | 'contains';

export function findEntitiesByName(
  services: BevyMcpServices,
  input: { name: string; match_mode?: NameMatchMode; port?: number },
): Promise<Array<{ entity: number; name: string }>>;

export function buildTypeGuide(typeName: string, registry: unknown): TypeGuide;
export function buildAllTypeGuides(registry: unknown): TypeGuide[];
```

- [ ] **Step 1: Write failing name-resolution tests**

Mock `world.query` to return reflected `Name` values. Verify:

- default mode is `exact`;
- `exact`, `prefix`, `suffix`, and `contains`;
- matching is case-sensitive;
- `*` is literal rather than wildcard syntax;
- deterministic ascending entity-ID order;
- empty results are valid.

- [ ] **Step 2: Implement `world_find_entities_by_name`**

Build exactly one standard `world.query` for the reflected `bevy_core::name::Name` component using both `data.components` and `filter.with`, then filter locally. Do not call `brp_execute`. Keep `findEntitiesByName()` exported because screenshot uses the exact-name path later.

- [ ] **Step 3: Write and implement `brp_execute` discovery validation**

```ts
await handler({ method: 'bevy_mcp/world_stats', params: { limit: 1 }, port: 15702 });
assert.equal(calls[0].method, 'rpc.discover');
assert.equal(calls[1].method, 'bevy_mcp/world_stats');
```

Unknown methods fail after discovery and never issue the second call. No other tool module imports the `brp_execute` handler.

- [ ] **Step 4: Implement `brp_list_agent_tools`**

Call BRP method `brp_extras/agent_tools`, normalize its returned tools array, and preserve `name`, `method`, `description`, `params_schema`, and `result_schema`. Add a unit fixture containing `bevy_mcp_world_stats` and `bevy_mcp_time_control`.

- [ ] **Step 5: Write failing type-guide tests from representative registry schemas**

Fixtures must include:

- a struct component with required scalar fields;
- a resource;
- an enum;
- a nested referenced type;
- a schema that cannot be constructed from JSON.

Assert the guide includes full path, short name, JSON shape, required fields, enum variants, nested references, and the appropriate component/resource mutation guidance.

- [ ] **Step 6: Implement one-pass type-guide generation**

`brp_type_guide` calls `registry.schema`, resolves one requested type, and passes it to `buildTypeGuide`.

`brp_all_type_guides` calls `registry.schema` once and maps the entire returned registry. It must not issue N registry requests for N types.

- [ ] **Step 7: Run tests and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/discovery-tools.test.js \
  .test-build/test/type-guides.test.js
```

```bash
git add src/tools test/discovery-tools.test.ts test/type-guides.test.ts
git commit -m "feat: add Bevy discovery and type tools"
```

---

### Task 5: Implement the complete BRP extras tool family

**Files:**
- Create: `src/tools/schemas/extras.ts`
- Create: `src/tools/extras.ts`
- Create: `test/extras-tools.test.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**
- Produces all 14 `brp_extras_*` MCP tools.
- Reuses `findEntitiesByName()` only for screenshot exact-name selection.

- [ ] **Step 1: Transcribe all extras parameter structs into Zod**

Port the pinned `ScreenshotParams`, `SendKeysParams`, `TypeTextParams`, `SetWindowTitleParams`, `MoveMouseParams`, `SendMouseButtonParams`, `ClickMouseParams`, `DoubleClickMouseParams`, `DragMouseParams`, `ScrollMouseParams`, `PinchGestureParams`, `RotationGestureParams`, `DoubleTapGestureParams`, and `GetDiagnosticsParams` contracts.

Add schema tests for required coordinates/buttons/text/path and mutually exclusive screenshot selectors.

- [ ] **Step 2: Register the 13 simple direct extras mappings**

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

- [ ] **Step 3: Write screenshot composite tests before implementation**

Cover:

```text
full capture                  -> direct screenshot params
camera-only capture           -> camera passed through
entity capture                -> entity + default/explicit padding
exact-name unique match       -> resolve name, send resolved entity
entity + name                 -> input error before BRP call
padding without entity/name   -> input error before BRP call
name with zero matches        -> actionable error
name with multiple matches    -> error containing candidate entity IDs
```

- [ ] **Step 4: Implement `brp_extras_screenshot` explicitly**

Never call `brp_execute`. Name selection calls `findEntitiesByName(..., match_mode: 'exact')`, requires exactly one result, then calls `brp_extras/screenshot` with entity/camera/padding/path.

- [ ] **Step 5: Verify mappings and annotations**

Read-only annotation only for diagnostics. Input/screenshot/mouse/keyboard/gesture operations are non-read-only. Set-window-title is idempotent.

- [ ] **Step 6: Run tests and commit**

```bash
npx tsc -p tsconfig.test.json && node --test .test-build/test/extras-tools.test.js
```

```bash
git add src/tools test/extras-tools.test.ts
git commit -m "feat: add Bevy extras MCP tools"
```

---

### Task 6: Implement watches as an owned runtime subsystem

**Files:**
- Create: `src/runtime/watch-manager.ts`
- Create: `src/tools/watches.ts`
- Create: `test/watch-manager.test.ts`
- Create: `test/watch-tools.test.ts`
- Modify: `src/services.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**

```ts
export interface ActiveWatch {
  id: number;
  kind: 'get_components' | 'list_components';
  entity: number;
  types?: string[];
  port: number;
  startedAt: string;
  logPath: string;
}

export class WatchManager {
  startGetComponents(input: { entity: number; types: string[]; port: number }): Promise<ActiveWatch>;
  startListComponents(input: { entity: number; port: number }): Promise<ActiveWatch>;
  list(): ActiveWatch[];
  stop(id: number): Promise<void>;
  stopAll(): Promise<void>;
}
```

- [ ] **Step 1: Write failing manager tests with a scripted fake BRP client**

Test that:

- IDs start at 1 and increase monotonically;
- initial read failure means no watch is registered;
- get-components requires at least one type;
- successful start returns numeric ID + log path;
- unchanged snapshots are not logged repeatedly;
- changed snapshots append one event;
- `list()` reports active watches;
- `stop(id)` aborts polling;
- stopping an unknown/inactive ID throws a watch-not-found error;
- `stopAll()` empties the registry.

Use a configurable 5 ms interval in tests; production default remains 250 ms.

- [ ] **Step 2: Implement stable snapshot comparison**

Add a small internal canonical JSON serializer that recursively sorts object keys before `JSON.stringify`. Arrays preserve order. This is only for watch equality; do not create a general serialization framework.

- [ ] **Step 3: Implement watch polling and watch log output**

`startGetComponents` performs an initial `world.get_components` call and polls the same method. `startListComponents` performs an initial `world.list_components` call and polls the same method. Each watch owns one `AbortController` and one log stream/file. Log only changed snapshots as timestamped JSON lines.

- [ ] **Step 4: Implement the four watch tools**

- `world_get_components_watch`
- `world_list_components_watch`
- `brp_list_active_watches`
- `brp_stop_watch`

`world_get_components_watch` schema requires `{ entity, types, port? }` and rejects an empty `types` array. Start tools return `watch_id` and `log_path`. `brp_stop_watch` accepts numeric `watch_id` and returns a tool error for an inactive ID.

- [ ] **Step 5: Run tests and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/watch-manager.test.js \
  .test-build/test/watch-tools.test.js
```

```bash
git add src/runtime/watch-manager.ts src/tools/watches.ts src/services.ts test/watch*.test.ts
git commit -m "feat: own Bevy watch lifecycle"
```

---

### Task 7: Implement Cargo discovery, build/launch, process tracking, logs, and tracing

**Files:**
- Create: `src/runtime/cargo.ts`
- Create: `src/runtime/process-manager.ts`
- Create: `src/runtime/log-store.ts`
- Create: `src/runtime/trace-logger.ts`
- Create: `src/tools/schemas/app.ts`
- Create: `src/tools/schemas/logs.ts`
- Create: `src/tools/app.ts`
- Create: `src/tools/logs.ts`
- Create: `test/cargo.test.ts`
- Create: `test/process-manager.test.ts`
- Create: `test/log-store.test.ts`
- Create: `test/app-tools.test.ts`
- Create: `test/log-tools.test.ts`
- Modify: `src/services.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**

```ts
export interface BevyTarget {
  name: string;
  kind: 'app' | 'example';
  packageName: string;
  manifestPath: string;
  packageRoot: string;
}

export interface BuildRequest {
  target: BevyTarget;
  profile: 'debug' | 'release';
}

export interface BuildArtifact {
  executable: string;
}

export class CargoRuntime {
  listTargets(root?: string): Promise<BevyTarget[]>;
  build(request: BuildRequest): Promise<BuildArtifact>;
}

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
```

- [ ] **Step 1: Write Cargo metadata normalization tests**

Use fixture JSON rather than shelling out in unit tests. Cover workspace bins, examples, duplicate names in different packages, and path scoping where metadata includes a package outside the caller's requested directory.

- [ ] **Step 2: Implement `CargoRuntime.listTargets()`**

Resolve a supplied directory or Cargo.toml to a manifest path, run:

```bash
cargo metadata --format-version 1 --no-deps --manifest-path <manifest>
```

Normalize only binary apps and examples. Sort deterministically by kind, package name, then target name.

- [ ] **Step 3: Write compiler-artifact parsing tests**

Feed Cargo JSON lines containing diagnostics plus multiple `compiler-artifact` messages. Select the artifact matching requested package/target/kind and require a non-null `executable` path.

- [ ] **Step 4: Implement `CargoRuntime.build()`**

Run Cargo with JSON messages:

```text
cargo build --message-format=json-render-diagnostics --manifest-path <manifest> --package <pkg> --bin <name>
```

or `--example <name>`. Add `--release` only for release profile. Parse Cargo's executable path instead of predicting `target/` layout. Do not implement custom freshness detection.

- [ ] **Step 5: Implement `LogStore` and path-containment tests**

Owned root:

```text
<tmp>/bevy-mcp/apps
<tmp>/bevy-mcp/watches
<tmp>/bevy-mcp/mcp
```

`LogStore` creates sanitized filenames, lists metadata, reads bounded full/tail content, and deletes only files whose canonical path remains under the owned root. Tests reject `../` traversal and absolute external paths.

- [ ] **Step 6: Implement `TraceLogger`**

Levels: `off | error | warn | info | debug | trace`. Default `info`. Write timestamp, level, scope, message, and optional JSON data to the current MCP trace file. `setLevel()` is immediate.

- [ ] **Step 7: Implement `ProcessManager` tests and launch**

`ProcessManager.launch()` receives an already-built executable, args/env/port/log path, spawns it with stdout/stderr redirected to the owned app log, calls `unref()` so the MCP server can exit independently, and records the PID.

Merge environment in this order:

```text
process.env < user env < BRP_EXTRAS_PORT=<assigned port>
```

- [ ] **Step 8: Implement `brp_list_bevy` and `brp_launch`**

`brp_launch` resolution rules:

1. resolve path/workspace targets;
2. choose app-first or example-first from `search_order`;
3. apply `package_name` when provided;
4. reject ambiguous matches with candidate package names;
5. validate base port + instance count - 1 <= 65534;
6. build once per selected target/profile;
7. spawn `instance_count` processes with consecutive ports;
8. return PIDs, ports, log files, target/package/profile metadata.

Transcribe `ListBevyParams` and `LaunchBevyBinaryParams` into Zod, including `target_name`, optional `profile`, `path`, `package_name`, `port`, `instance_count`, `env`, `search_order`, and `args`.

- [ ] **Step 9: Implement `brp_status` and `brp_shutdown`**

`brp_status` reports tracked process information and performs a live `rpc.discover` probe on the selected port to distinguish a running process from a ready BRP app.

`brp_shutdown` first calls `brp_extras/shutdown`; then waits a bounded interval for tracked process exit. If a tracked PID is still alive, send ordinary process termination and report the method used. Do not add a process-tree library in this PR.

- [ ] **Step 10: Implement all five log/trace tools**

- `brp_list_logs`
- `brp_read_log`
- `brp_delete_logs`
- `brp_get_trace_log_path`
- `brp_set_tracing_level`

Transcribe the pinned upstream public parameter fields, but map them onto the repository-owned log root and trace logger.

- [ ] **Step 11: Run tests and commit**

```bash
npx tsc -p tsconfig.test.json && node --test \
  .test-build/test/cargo.test.js \
  .test-build/test/process-manager.test.js \
  .test-build/test/log-store.test.js \
  .test-build/test/app-tools.test.js \
  .test-build/test/log-tools.test.js
```

```bash
git add src/runtime src/tools src/services.ts test
git commit -m "feat: own Bevy app runtime and logs"
```

---

### Task 8: Finish registration and make the exact 49-tool catalog gate green

**Files:**
- Modify: `src/tools/register.ts`
- Modify: `test/catalog.test.ts`
- Modify domain tests as needed for annotations/descriptions

**Interfaces:**
- `registerTools()` is the only whole-catalog composition point.
- Domain modules expose `registerXTools(server, services)` functions only; they do not import each other except the explicit screenshot -> `findEntitiesByName` helper.

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

No reflection or auto-discovery of modules.

- [ ] **Step 2: Extend the catalog test to spy on real registration**

Use a minimal `McpServer` test double whose `registerTool(name, ...)` records names, then call the real `registerTools()` with fake services:

```ts
const registered: string[] = [];
const server = {
  registerTool(name: string) {
    registered.push(name);
  },
} as unknown as McpServer;

registerTools(server, fakeServices());
assert.equal(registered.length, 49);
assert.equal(new Set(registered).size, 49);
assert.deepEqual(registered.slice().sort(), EXPECTED_TOOL_NAMES.slice().sort());
```

This keeps the unit catalog gate independent of build artifacts. Task 9 integration separately verifies the actual MCP client's `listTools()` response.

- [ ] **Step 3: Add standard MCP annotations**

Map each tool to read-only/destructive/idempotent hints consistent with behavior. At minimum:

- list/get/query/discover/status/log-read/type-guide/diagnostics are read-only;
- insert/mutate/reparent/set-title are mutating idempotent where repeated input has the same effect;
- spawn/events/input/click/gesture/launch are non-idempotent;
- remove/despawn/delete-logs/shutdown/stop-watch are destructive.

- [ ] **Step 4: Run complete Node unit suite**

```bash
npm test
npm run typecheck
npm run build
```

Expected: PASS, including exact 49-tool registration.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: complete Bevy MCP tool catalog"
```

---

### Task 9: Expand the full Bevy fixture and replace upstream-based integration coverage

**Files:**
- Modify: `fixtures/full-app/src/main.rs`
- Modify: `scripts/integration.mjs`
- Modify: `package.json` only if integration script flags change

**Interfaces:**
- Fixture exposes reflected `FixtureMarker`, a mutable reflected component with data, a mutable reflected resource, and uniquely named entities.
- Integration launches `build/index.js` directly through `@modelcontextprotocol/client`.

- [ ] **Step 1: Expand the fixture data model**

Add reflected types such as:

```rust
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct FixtureValue {
    value: i32,
}

#[derive(Resource, Reflect, Default)]
#[reflect(Resource)]
struct FixtureState {
    elapsed: f32,
    counter: i32,
}
```

Register them and spawn at least one uniquely named entity, e.g. `Name::new("FixturePrimary")`, containing `FixtureMarker` + `FixtureValue { value: 1 }`.

Keep the visible camera/mesh so screenshot remains meaningful.

- [ ] **Step 2: Remove all upstream assumptions from integration setup**

Delete comments/checks for `bevy_brp_mcp` on PATH or `BEVY_BRP_MCP_BIN`. The MCP transport remains:

```js
new StdioClientTransport({
  command: process.execPath,
  args: ['build/index.js'],
  cwd: repoRoot,
  stderr: 'inherit',
  env: { ...process.env },
});
```

- [ ] **Step 3: Assert the complete 49-tool list first**

Integration must fail before launching a fixture if any tool is missing or duplicated.

- [ ] **Step 4: Exercise one real behavior path from every domain**

Required journey:

```text
MCP initialize
-> list 49 tools
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
-> poll/read watch log until change appears
-> brp_stop_watch
-> brp_type_guide FixtureValue
-> brp_list_agent_tools validates world_stats/time_control schemas
-> brp_execute bevy_mcp/world_stats
-> brp_execute bevy_mcp/time_control pause/resume
-> brp_extras_get_diagnostics
-> one harmless input operation (set window title)
-> brp_extras_screenshot to temp PNG
-> brp_list_logs + brp_read_log for launched app
-> brp_shutdown
-> verify launched PID exits
```

Use `eventually()` polling only for app readiness, watch log observation, and process exit; do not hide tool-call failures with retries.

- [ ] **Step 5: Run the real journey locally/CI-style**

```bash
cargo build -p bevy-mcp-fixture
npm run build
xvfb-run -a npm run test:integration
```

Expected: PASS without installing or executing upstream MCP.

- [ ] **Step 6: Commit**

```bash
git add fixtures/full-app/src/main.rs scripts/integration.mjs package.json
git commit -m "test: cover owned Bevy MCP end to end"
```

---

### Task 10: Enforce upstream independence, update CI/package docs, and remove obsolete architecture

**Files:**
- Create: `scripts/check-no-upstream-runtime.mjs`
- Create: `test/upstream-independence.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Delete: `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`
- Delete: `docs/superpowers/plans/2026-09-03-generic-bevy-mcp.md`
- Keep: `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`
- Keep: `docs/superpowers/plans/2026-09-07-owned-bevy-mcp-server.md`

**Interfaces:**
- Produces `npm run check:no-upstream`.
- CI proves the package works without `bevy_brp_mcp` installation.

- [ ] **Step 1: Write the independence guard**

Scan these production/package paths recursively:

```js
const roots = [
  'src',
  'test',
  'scripts',
  '.github',
  'plugins',
  'package.json',
  'package-lock.json',
  'mcp.json',
  'plugin.json',
  'README.md',
];
```

Fail when active code/config/docs in those roots contains any of:

```text
cargo install bevy_brp_mcp
BEVY_BRP_MCP_BIN
spawn.*bevy_brp_mcp
command.*bevy_brp_mcp
```

The historical name may appear in the new design/plan docs explaining removal, so `docs/superpowers` is intentionally outside this runtime guard.

- [ ] **Step 2: Add package script and test**

```json
"check:no-upstream": "node scripts/check-no-upstream-runtime.mjs"
```

`test/upstream-independence.test.ts` imports the scanner and asserts zero violations. CI also calls the script directly.

- [ ] **Step 3: Remove the CI upstream install step**

Delete:

```yaml
- name: Install upstream MCP server
  run: cargo install bevy_brp_mcp --version 0.22.3 --locked
```

Add `npm run check:no-upstream` before the integration journey. Keep Xvfb/system dependencies needed by the Bevy fixture.

- [ ] **Step 4: Rewrite README around the owned server**

README must state:

- npm package is the MCP server, not a launcher;
- prerequisites are Node/Rust plus adding `BevyMcpPlugin` to the target game;
- no separate MCP Cargo install;
- tool categories and the 49-tool owned surface;
- `bevy_brp_extras` remains app-side via the bridge;
- `BRP_EXTRAS_PORT` is set automatically by `brp_launch`;
- development commands use local server integration only.

Remove all launcher/upstream prerequisite sections.

- [ ] **Step 5: Delete superseded September 3 spec/plan**

Delete both old docs so the repository has one current architecture story.

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
xvfb-run -a npm run test:integration
```

Expected: all PASS on a machine where `bevy_brp_mcp` is not installed.

- [ ] **Step 7: Inspect packed npm contents**

```bash
npm pack --dry-run
```

Verify `build/**`, `plugin.json`, and `mcp.json` are included and no external executable/vendor payload is required.

- [ ] **Step 8: Commit final migration**

```bash
git add .github package.json package-lock.json README.md scripts test docs
git commit -m "docs: finish owned Bevy MCP migration"
```

---

## Final self-review checklist

Before opening/updating the single implementation PR, verify all of the following manually:

- [ ] Exactly 49 public MCP tools are registered; no helper/internal tool leaks.
- [ ] Every `ToolName` variant from pinned upstream commit `85d0eca...` has a local implementation or the explicitly always-enabled trace equivalent.
- [ ] Every known public parameter struct was transcribed into Zod; no root catch-all schema hides unfinished parity.
- [ ] No handler except `brp_execute` accepts a dynamic BRP method.
- [ ] No handler imports/calls `brp_execute` as a fallback.
- [ ] `world_find_entities_by_name` supports exact/prefix/suffix/contains and case-sensitive literal matching.
- [ ] Screenshot and entity-name lookup are real composites.
- [ ] Watch IDs are monotonic numeric IDs and owned by one `WatchManager`.
- [ ] Unknown `brp_stop_watch` IDs produce tool errors.
- [ ] Watches are cleaned up on MCP server shutdown.
- [ ] Cargo uses metadata + JSON compiler artifacts, not handwritten Cargo.toml parsing or upstream freshness logic.
- [ ] Process state is in memory only.
- [ ] Log tools are restricted to the owned temp root.
- [ ] Type guides use one registry response for the all-types path.
- [ ] Packed smoke test performs a real MCP initialization against the installed tarball.
- [ ] Integration starts `build/index.js` directly and covers every tool family.
- [ ] CI never installs `bevy_brp_mcp`.
- [ ] Packed npm package is sufficient to start the MCP server.
- [ ] Old upstream-delegation design/plan are removed.
- [ ] README has no upstream MCP installation instructions.

## Execution handoff

Implementation should continue on `agent/owned-bevy-mcp-server-plan` so the approved design, this plan, and all code land in one PR. Use subagent-driven development task-by-task, with TDD and review between tasks. Do not split these tasks into separate PRs.
