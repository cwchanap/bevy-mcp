# Generic Bevy MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one generic local MCP/plugin package that launches and debugs Bevy 0.19 applications through official BRP plus `bevy_brp_extras`, with reflected ECS inspection/mutation, process/log control, input, validated screenshots, diagnostics, world statistics, virtual-time control, and agent-plugin packaging.

**Architecture:** A Node/TypeScript stdio MCP server owns Cargo discovery, one managed child process, capability negotiation, stable MCP schemas, and localhost BRP translation. A small Rust `bevy-mcp-bridge` plugin composes `BrpExtrasPlugin` and registers only `bevy_mcp/world_stats` and `bevy_mcp/time_control`. Standalone `bevy_ecs::World` transport is deferred; a future slice must reuse public `bevy_remote::builtin_methods` instead of implementing a second BRP.

**Tech Stack:** Node.js >=20, TypeScript 6, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client` for tests/smokes), Zod v4, Vitest, Rust >=1.95, Bevy 0.19.1, `bevy_brp_extras` 0.22.3, GitHub Actions, Agent Plugins 1.0.0.

**Spec:** `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`

## Global Constraints

- Continue implementation on existing draft PR #1 and branch `agent/generic-bevy-mcp-design`; do not open a second PR.
- V1 supports Bevy 0.19.x only.
- Native runtime debugging only; no WASM/browser relay.
- No game-specific tools or semantic operations.
- No standalone `bevy_ecs` transport in v1.
- Reuse official BRP for ECS and `bevy_brp_extras` 0.22.3 for screenshot/input/diagnostics/shutdown.
- Reflection is the only generic inspection/mutation boundary.
- Connect only to `127.0.0.1`, default port 15702.
- Runtime request timeout: 5 seconds. Graceful-stop window: 2 seconds.
- `query_entities`: default 200 returned rows, maximum 2000; this is an MCP response cap only.
- `get_debug_output`: default 200 lines, maximum 5000.
- Screenshot PNG maximum: 16 MiB before base64 encoding.
- Manage at most one child process per MCP server.
- Do not add automatic Cargo/source rewriting, auth/TLS/retry framework, daemon, database, web UI, replay, test DSL, profiler, or cross-engine abstraction.

---

## Planned file structure

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
LICENSE
README.md
plugin.json
mcp.json

src/
  index.ts
  server.ts
  project/
    cargo.ts
    cargo.spec.ts
    process-manager.ts
    process-manager.spec.ts
  runtime/
    client.ts
    client.spec.ts
    capabilities.ts
    capabilities.spec.ts
    errors.ts
    types.ts
  tools/
    project.ts
    world.ts
    world.spec.ts
    control.ts
    control.spec.ts
    visual.ts
    visual.spec.ts
    diagnostics.ts
    diagnostics.spec.ts
    bridge.ts
    bridge.spec.ts
  screenshot/
    png.ts
    png.spec.ts

Cargo.toml
crates/bevy-mcp-bridge/
  Cargo.toml
  src/lib.rs
  src/methods.rs
  tests/plugin.rs
fixtures/full-app/
  Cargo.toml
  src/main.rs

scripts/
  integration.mjs
  smoke-packed-cli.mjs

plugins/bevy-plugin/
  .mcp.json
  .codex-plugin/plugin.json
  .claude-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
.github/workflows/ci.yml
```

There is no `reflect.rs`, standalone HTTP server, ECS-only fixture, or second protocol implementation in v1.

---

### Task 1: Bootstrap the npm MCP, Cargo discovery, build/run control, and logs

**Files:**
- Create: `package.json`
- Create: `package-lock.json` via `npm install`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `LICENSE`
- Create: `src/index.ts`
- Create: `src/server.ts`
- Create: `src/project/cargo.ts`
- Create: `src/project/cargo.spec.ts`
- Create: `src/project/process-manager.ts`
- Create: `src/project/process-manager.spec.ts`
- Create: `src/tools/project.ts`

**Interfaces:**
- `discoverBevyTargets(root: string): Promise<BevyTarget[]>`
- `resolveTarget(targets: BevyTarget[], selection: TargetSelection): BevyTarget`
- `buildTarget(spec: BuildSpec): Promise<BuildResult>`
- `ProcessManager.run/stop/restart/status/getOutput`
- `createServer(deps?: ServerDeps): McpServer`

- [ ] **Step 1: Create npm/TS manifests**

`package.json`:

```json
{
  "name": "@cwchanap/bevy-plugin",
  "version": "0.1.0",
  "description": "Generic MCP server for inspecting, controlling, and debugging Bevy applications.",
  "type": "module",
  "license": "MIT",
  "bin": { "bevy-plugin": "build/index.js" },
  "files": ["build", "plugin.json", "mcp.json"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:integration": "node scripts/integration.mjs",
    "prepack": "npm run build",
    "smoke:packed": "node scripts/smoke-packed-cli.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@types/node": "^24.0.0",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  }
}
```

`tsconfig.json` uses `NodeNext`, strict mode, ES2022, `build/`, declarations, and explicit `"types": ["node"]`.

Run:

```bash
npm install
```

Expected: lockfile generated; install succeeds.

- [ ] **Step 2: Write failing Cargo discovery tests**

Lock behavior from `cargo metadata --no-deps --format-version=1`:

```ts
expect(await discoverBevyTargets('/repo', fakeExec(metadata))).toEqual([
  expect.objectContaining({ packageName: 'game', targetName: 'game', kind: 'bin', runtimeKind: 'full_bevy' }),
  expect.objectContaining({ packageName: 'game', targetName: 'sandbox', kind: 'example', runtimeKind: 'full_bevy' })
]);
```

`runtimeKind` is `full_bevy` when the package directly depends on `bevy` or `bevy_brp_extras`; otherwise `unknown`.

Run:

```bash
npm test -- src/project/cargo.spec.ts
```

Expected: FAIL before implementation.

- [ ] **Step 3: Implement discovery and exact target resolution**

```ts
export interface BevyTarget {
  packageName: string;
  manifestPath: string;
  targetName: string;
  kind: 'bin' | 'example';
  runtimeKind: 'full_bevy' | 'unknown';
}
```

Invoke Cargo with `execFile`, never a shell string. Sort by package/kind/target.

- [ ] **Step 4: Write failing build/process tests**

Lock argv:

```text
cargo build -p <package> --bin <target>
cargo build -p <package> --example <target>
cargo run -p <package> --bin <target> -- <args...>
cargo run -p <package> --example <target> -- <args...>
```

Prove:

- second concurrent `run` -> `process_already_running`;
- `BRP_EXTRAS_PORT` is set to selected port;
- output ring retains last 5000 lines;
- `getOutput({ lines: 2 })` returns the last two lines;
- restart reuses the prior launch spec.

- [ ] **Step 5: Implement build/process manager**

Use `execFile` for build and `spawn` for run:

```ts
spawn('cargo', argv, {
  cwd: spec.root,
  env: { ...process.env, BRP_EXTRAS_PORT: String(spec.port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
```

Append stdout/stderr to a temp log file as well as the ring buffer.

- [ ] **Step 6: Register project/process MCP tools**

```text
list_bevy_targets
build_bevy
run_bevy
stop_bevy
restart_bevy
get_debug_output
```

Bootstrap:

```ts
#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

void serveStdio(() => createServer());
```

Task 4 later upgrades `stop_bevy` to graceful BRP shutdown first.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck
npm test
npm run build
```

Commit:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts LICENSE src
 git commit -m "feat: add Bevy project and process foundation"
```

---

### Task 2: Add BRP client, capabilities, typed ECS read/write tools, and raw method escape hatch

**Files:**
- Create: `src/runtime/client.ts`
- Create: `src/runtime/client.spec.ts`
- Create: `src/runtime/capabilities.ts`
- Create: `src/runtime/capabilities.spec.ts`
- Create: `src/runtime/errors.ts`
- Create: `src/runtime/types.ts`
- Create: `src/tools/world.ts`
- Create: `src/tools/world.spec.ts`
- Create: `src/tools/diagnostics.ts`
- Create: `src/tools/diagnostics.spec.ts`
- Modify: `src/server.ts`

**Interfaces:**
- `RuntimeClient.call<T>(method: string, params?: unknown): Promise<T>`
- `probeRuntime(port: number, managed: boolean): Promise<RuntimeStatus>`
- stable read result types from the spec
- ECS read/write tools plus `list_remote_methods`/`call_remote_method`

- [ ] **Step 1: Write failing JSON-RPC client tests**

With a fake local HTTP server, prove exact request shape:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "world.list_components" }
```

Cover success, BRP error, non-2xx, malformed JSON, and five-second timeout -> `runtime_unreachable`.

- [ ] **Step 2: Implement `RuntimeClient`**

Use built-in `fetch` only:

```ts
await fetch(`http://127.0.0.1:${port}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request),
  signal: controller.signal
});
```

Preserve BRP code/message in `remote_error.details`.

- [ ] **Step 3: Pin read result types before handlers**

`src/runtime/types.ts`:

```ts
export interface ListComponentsResult { components: string[] }
export interface ListResourcesResult { resources: string[] }
export interface TypeSchemaResult { schema: Record<string, unknown> }
export interface ComponentReadError { message: string; code?: number }
export interface EntitySnapshot {
  entity: number;
  components: Record<string, unknown>;
  errors: Record<string, ComponentReadError>;
}
export interface ResourceSnapshot { resource: string; value: unknown }
export interface QueryRow {
  entity: number;
  components: Record<string, unknown>;
  has?: Record<string, boolean>;
}
export interface QueryEntitiesResult {
  rows: QueryRow[];
  returned: number;
  truncated: boolean;
}
```

- [ ] **Step 4: Write failing capability tests using only `rpc.discover`**

Derive flags from exact methods. Removing `brp_extras/screenshot`, `brp_extras/get_diagnostics`, or `bevy_mcp/time_control` must only disable their matching capability.

No bridge method returns hardcoded render/input/diagnostics flags.

- [ ] **Step 5: Implement discovery/capability probing**

```ts
export interface RuntimeStatus {
  reachable: boolean;
  port: number;
  methods: string[];
  capabilities: RuntimeCapabilities;
}
```

Sort discovered methods. `process` comes from `ProcessManager`; a reachable BRP endpoint implies `app: true`.

- [ ] **Step 6: Write failing read-tool mapping tests**

Lock mappings:

```text
list_components -> world.list_components -> { components }
list_resources  -> world.list_resources  -> { resources }
get_type_schema -> registry.schema       -> { schema }
get_resource    -> world.get_resources   -> { resource, value }
```

`get_entity` without component names performs `world.list_components({ entity })`, then non-strict `world.get_components`, preserving both `components` and `errors`.

`query_entities` forwards only standard BRP fields:

```ts
{
  data: { components, option: optional, has },
  filter: { with, without },
  strict
}
```

If BRP returns 250 rows and `limit=200`, MCP returns 200 with `truncated: true`. Never send `limit`/`bevy_mcp_limit` to BRP.

- [ ] **Step 7: Implement read tools**

```text
get_runtime_status
list_components
list_resources
get_type_schema
query_entities
get_entity
get_resource
get_world_stats
```

Before Task 3, `get_world_stats` returns `unsupported_capability` if the custom method is absent.

- [ ] **Step 8: Write failing mutation/raw-call tests**

Mappings:

```text
spawn_entity      -> world.spawn_entity
remove_entity     -> world.despawn_entity
set_components    -> world.insert_components
mutate_component  -> world.mutate_components
remove_components -> world.remove_components
set_resource      -> world.insert_resources
mutate_resource   -> world.mutate_resources
remove_resource   -> world.remove_resources
```

Void success -> `{ ok: true }`; spawn -> `{ entity }`.

`call_remote_method` must reject a method absent from the latest discovery result before transport.

- [ ] **Step 9: Implement mutation and protocol tools**

```text
spawn_entity
remove_entity
set_components
mutate_component
remove_components
set_resource
mutate_resource
remove_resource
list_remote_methods
call_remote_method
```

No game-aware validation.

- [ ] **Step 10: Verify and commit**

```bash
npm run typecheck
npm test
npm run build
```

Commit:

```bash
git add src/runtime src/tools src/server.ts
 git commit -m "feat: add generic BRP world tools"
```

---

### Task 3: Add the full-Bevy bridge plugin and one real runtime fixture

**Files:**
- Create: `Cargo.toml`
- Create: `crates/bevy-mcp-bridge/Cargo.toml`
- Create: `crates/bevy-mcp-bridge/src/lib.rs`
- Create: `crates/bevy-mcp-bridge/src/methods.rs`
- Create: `crates/bevy-mcp-bridge/tests/plugin.rs`
- Create: `fixtures/full-app/Cargo.toml`
- Create: `fixtures/full-app/src/main.rs`

**Interfaces:**
- `bevy_mcp_bridge::BevyMcpPlugin`
- remote `bevy_mcp/world_stats`
- remote `bevy_mcp/time_control`
- one full-app fixture for later E2E

- [ ] **Step 1: Create Cargo workspace only when members exist**

Root:

```toml
[workspace]
members = [
  "crates/bevy-mcp-bridge",
  "fixtures/full-app",
]
default-members = ["crates/bevy-mcp-bridge"]
resolver = "3"
```

Bridge:

```toml
[package]
name = "bevy-mcp-bridge"
version = "0.1.0"
edition = "2024"
rust-version = "1.95"
license = "MIT"

[dependencies]
bevy = { version = "0.19.1", default-features = false, features = ["bevy_remote", "bevy_time", "png"] }
bevy_brp_extras = "0.22.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Fixture depends on `bevy = "0.19.1"` and path `bevy-mcp-bridge`.

Run:

```bash
cargo metadata --no-deps --format-version=1 > /dev/null
```

Expected: PASS.

- [ ] **Step 2: Write failing Rust tests**

Prove:

- `rpc.discover` contains `bevy_mcp/world_stats` and `bevy_mcp/time_control` after plugin registration;
- world stats report entity/archetype/component counts;
- time control pauses/resumes/changes relative speed;
- tests do not assert hardcoded render/input/diagnostics capability flags.

Run:

```bash
cargo test -p bevy-mcp-bridge
```

Expected: FAIL.

- [ ] **Step 3: Implement `BevyMcpPlugin` by composing `BrpExtrasPlugin`**

Add `BrpExtrasPlugin`, register the two method systems with the app world, and insert them into `RemoteMethods` as instant methods.

Representative shape:

```rust
app.add_plugins(BrpExtrasPlugin);
let stats = app.world_mut().register_system(methods::world_stats);
let time = app.world_mut().register_system(methods::time_control);
let mut remote = app.world_mut().resource_mut::<RemoteMethods>();
remote.insert("bevy_mcp/world_stats", RemoteMethodSystemId::Instant(stats));
remote.insert("bevy_mcp/time_control", RemoteMethodSystemId::Instant(time));
```

Adapt only the exact string ownership/signature required by Bevy 0.19.1; do not create a registration framework.

- [ ] **Step 4: Implement world stats**

Return:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorldStats {
    entities: usize,
    archetypes: usize,
    component_counts: BTreeMap<String, usize>,
}
```

Use current archetypes: each archetype's entity count contributes to each component type in that archetype. No history/profiling.

- [ ] **Step 5: Implement virtual-time control**

Accepted params:

```json
{ "action": "pause" }
{ "action": "resume" }
{ "action": "set_scale", "scale": 2.0 }
```

Use `Time<Virtual>::pause`, `unpause`, `set_relative_speed`. Reject non-finite/non-positive scale as invalid params. Return current paused/relative-speed state.

- [ ] **Step 6: Create the full-app fixture**

Include:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct DebugCounter(u32);

#[derive(Resource, Reflect, Default)]
#[reflect(Resource)]
struct InputState { key_a_presses: u32 }
```

Register both types. Spawn `DebugCounter`, a `Camera2d`, and a visible primitive. Add a system that increments `InputState.key_a_presses` on `KeyCode::KeyA` just-pressed. Add `BevyMcpPlugin`.

- [ ] **Step 7: Verify and commit**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Commit:

```bash
git add Cargo.toml crates fixtures/full-app
 git commit -m "feat: add Bevy MCP bridge plugin"
```

---

### Task 4: Add time/input/screenshot/diagnostics/shutdown tools with PNG validation

**Files:**
- Create: `src/tools/control.ts`
- Create: `src/tools/control.spec.ts`
- Create: `src/tools/visual.ts`
- Create: `src/tools/visual.spec.ts`
- Create: `src/screenshot/png.ts`
- Create: `src/screenshot/png.spec.ts`
- Modify: `src/tools/diagnostics.ts`
- Modify: `src/tools/diagnostics.spec.ts`
- Modify: `src/project/process-manager.ts`
- Modify: `src/project/process-manager.spec.ts`
- Modify: `src/server.ts`

**Interfaces:**
- `control_time`, `send_keys`, `type_text`, `mouse_input`, `capture_screenshot`, `get_diagnostics`, `shutdown_runtime`
- `validatePngFile(path: string): Promise<ValidatedPng>`
- managed stop tries graceful BRP shutdown first

- [ ] **Step 1: Write failing control/input mapping tests**

Mappings:

```text
control_time -> bevy_mcp/time_control
send_keys    -> brp_extras/send_keys
type_text    -> brp_extras/type_text
```

`mouse_input` actions are exactly:

```text
move         -> brp_extras/move_mouse
click        -> brp_extras/click_mouse
double_click -> brp_extras/double_click_mouse
press        -> brp_extras/send_mouse_button
drag         -> brp_extras/drag_mouse
scroll       -> brp_extras/scroll_mouse
```

`press` carries `button`, optional `duration_ms`, optional window ID and represents timed press-hold-release. There are no `button_down`/`button_up` actions.

Each handler checks discovery before calling the method.

- [ ] **Step 2: Implement control/input tools**

`control_time` validates:

```ts
z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('set_scale'), scale: z.number().finite().positive() })
]);
```

Keep extras payload field names (`duration_ms`, etc.) at the runtime boundary; MCP schemas may expose camelCase but must map explicitly.

- [ ] **Step 3: Write failing PNG validation tests**

Reject:

- missing file;
- file >16 MiB from `stat` before full read;
- invalid signature;
- truncated header;
- missing `IHDR`;
- width 0;
- height 0.

Valid PNG returns width/height/byteLength.

- [ ] **Step 4: Implement PNG guard**

```ts
export const MAX_SCREENSHOT_PNG_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
```

Algorithm:

1. `fs.stat` and size check;
2. read first 24 bytes;
3. validate signature;
4. require bytes 12..15 = `IHDR`;
5. read big-endian width/height from bytes 16..23 and require >0;
6. only then `fs.readFile`.

Return:

```ts
export interface ValidatedPng {
  bytes: Buffer;
  width: number;
  height: number;
  byteLength: number;
}
```

- [ ] **Step 5: Write failing screenshot-tool tests**

`capture_screenshot` must:

1. create a temp `.png` path;
2. call `brp_extras/screenshot` with `{ path, camera?, entity?, padding? }`;
3. validate file;
4. return MCP image content as `image/png`;
5. remove temp file in `finally` on success/failure.

Oversized PNG must return no image content.

- [ ] **Step 6: Implement screenshot/diagnostics/shutdown tools**

```text
capture_screenshot -> brp_extras/screenshot
get_diagnostics    -> brp_extras/get_diagnostics
shutdown_runtime   -> brp_extras/shutdown
```

Register all tool handlers in `server.ts`.

- [ ] **Step 7: Upgrade managed stop to graceful shutdown first**

If runtime is reachable and advertises `brp_extras/shutdown`:

1. call it;
2. wait up to 2 seconds for child exit;
3. terminate only if still alive.

Unit test fallback with fake timers/child handle.

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck
npm test
npm run build
cargo test --workspace
```

Commit:

```bash
git add src
 git commit -m "feat: add Bevy runtime control and screenshots"
```

---

### Task 5: Add bridge setup/status and one real MCP-client full-app journey

**Files:**
- Create: `src/tools/bridge.ts`
- Create: `src/tools/bridge.spec.ts`
- Create: `scripts/integration.mjs`
- Modify: `src/server.ts`
- Modify: `fixtures/full-app/src/main.rs` only if integration reveals a fixture-observability gap

**Interfaces:**
- `get_bridge_status`
- `get_bridge_setup`
- one real MCP v2 client integration journey

- [ ] **Step 1: Write failing bridge tests**

Result:

```ts
export interface BridgeStatus {
  dependencyPresent: boolean;
  runtimeReachable: boolean;
  worldStatsAvailable: boolean;
  timeControlAvailable: boolean;
}
```

Setup output must include exactly:

```bash
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

and:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

No mutation tool.

- [ ] **Step 2: Implement bridge status/setup**

Static dependency presence from Cargo metadata; runtime methods from `rpc.discover`. Register both tools.

- [ ] **Step 3: Build integration script with real MCP client**

Imports:

```js
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

Start `node build/index.js`, connect with `Client.connect()`, and choose a free BRP port.

- [ ] **Step 4: Execute the full journey only through MCP tools**

Sequence:

1. `list_bevy_targets` -> find `bevy-mcp-full-fixture`;
2. `run_bevy` with free port;
3. poll `get_runtime_status` until reachable or 20s timeout;
4. `list_components` -> reflected `DebugCounter` exists;
5. `query_entities` -> get its entity ID;
6. `mutate_component` -> change value;
7. `get_entity` -> verify new value;
8. `control_time` pause/set scale/resume;
9. `send_keys` with `KeyA`;
10. poll `get_resource` until `InputState.key_a_presses >= 1`;
11. `capture_screenshot` -> non-empty PNG image content;
12. `get_diagnostics`;
13. `get_world_stats`;
14. `stop_bevy`;
15. `get_debug_output` -> fixture startup line present.

Polling delay <=100ms; no long arbitrary sleeps.

- [ ] **Step 5: Run integration under Xvfb**

```bash
npm run build
xvfb-run -a npm run test:integration
```

Expected: PASS. Keep real renderer/screenshot path; do not replace it with a fake if CI needs Linux packages.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
xvfb-run -a npm run test:integration
```

Commit:

```bash
git add src/tools/bridge.ts src/tools/bridge.spec.ts src/server.ts scripts/integration.mjs fixtures/full-app
 git commit -m "test: cover generic Bevy MCP runtime journey"
```

---

### Task 6: Package agent plugins, packed smoke, README, CI, and npm publication

**Files:**
- Create: `plugin.json`
- Create: `mcp.json`
- Create: `plugins/bevy-plugin/.mcp.json`
- Create: `plugins/bevy-plugin/.codex-plugin/plugin.json`
- Create: `plugins/bevy-plugin/.claude-plugin/plugin.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `scripts/smoke-packed-cli.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create if useful: `src/packaging/metadata.spec.ts`

**Interfaces:**
- one npm binary `@cwchanap/bevy-plugin`
- every agent wrapper invokes that same binary
- release/manual publish job publishes npm

- [ ] **Step 1: Write plugin metadata**

Root `mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "bevy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cwchanap/bevy-plugin@0.1.0"]
    }
  }
}
```

Root `plugin.json`: Agent Plugins 1.0.0, name `bevy-plugin`, version `0.1.0`, repo `https://github.com/cwchanap/bevy-mcp`, MIT.

Codex/Claude/marketplace wrappers reuse the same MCP command; no client-specific server.

- [ ] **Step 2: Add metadata unit test**

Read every metadata JSON and assert:

- MCP server name `bevy`;
- command `npx`;
- args exactly `-y @cwchanap/bevy-plugin@0.1.0`;
- plugin version `0.1.0`.

- [ ] **Step 3: Implement packed MCP smoke using `@modelcontextprotocol/client`**

`scripts/smoke-packed-cli.mjs`:

1. `npm pack --json`;
2. install tarball into temp directory;
3. start installed `bevy-plugin` with `StdioClientTransport`;
4. `await client.connect(transport)`;
5. `client.listTools()`;
6. assert at least `list_bevy_targets`, `run_bevy`, `query_entities`, `capture_screenshot`, `get_runtime_status`;
7. close/delete temp artifacts in `finally`.

No handwritten MCP initialize packet.

Run:

```bash
npm run build
npm run smoke:packed
```

Expected: PASS.

- [ ] **Step 4: Rewrite README for actual v1**

Must cover:

- purpose/tool categories;
- Node/Rust/Bevy 0.19 requirements;
- npm/MCP/Codex/Claude/Agent Plugins setup;
- bridge Git install + one-line plugin snippet;
- reflection + `register_type` requirement for game-owned types;
- BRP/`bevy_brp_extras` apps already support standard subset;
- no `step_frame`;
- supported mouse actions (`move`, `click`, `double_click`, timed `press`, `drag`, `scroll`);
- localhost/native-only behavior;
- query response cap and 16 MiB screenshot cap;
- standalone ECS deferred; future bridge must reuse `bevy_remote::builtin_methods`.

No game-specific instructions.

- [ ] **Step 5: Add CI and npm publish job**

Triggers: push/PR to `main`, release published, workflow dispatch with `trigger_publish`.

Linux setup:

```bash
sudo apt-get update
sudo apt-get install -y xvfb libasound2-dev libudev-dev pkg-config
```

CI gates:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:packed
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
xvfb-run -a npm run test:integration
```

Publish condition:

```yaml
if: ${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.event.inputs.trigger_publish == 'true') }}
```

Publish:

```bash
npm ci
npm run build
npm publish
```

with npm registry configured in `actions/setup-node` and `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`.

No crates.io publish in v1; Rust setup uses Git.

- [ ] **Step 6: Run final gate**

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:packed
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
xvfb-run -a npm run test:integration
```

Expected: all PASS.

- [ ] **Step 7: Scope/self-review**

Production scan:

```bash
rg "EcsBridge|bevy_mcp_limit|standalone_ecs|install_bridge_dependency|BEVY_MCP_PORT" src crates fixtures scripts package.json Cargo.toml
```

Expected: no production matches. Documentation may mention `EcsBridge`/standalone only as future direction.

Game-specific scan:

```bash
rg -i "scorpius|caelum|battle_snapshot|transport_demand" src crates fixtures scripts
```

Expected: no matches.

Verify PR diff and ensure implementation stays on PR #1.

- [ ] **Step 8: Commit and update the existing draft PR**

```bash
git add README.md plugin.json mcp.json plugins .agents .claude-plugin scripts/smoke-packed-cli.mjs .github src/packaging
 git commit -m "docs: package generic Bevy agent plugin"
```

Push `agent/generic-bevy-mcp-design`, update PR #1 with implementation/verification evidence, and keep it as the only PR for this task.

---

## Deferred standalone ECS rule

No standalone ECS implementation is hidden inside v1.

When a real caller-owned `bevy_ecs::World` host exists, create a new design slice that keeps the same npm MCP/tool surface and extends the Rust crate with a caller-polled transport. That future implementation must use the world's `AppTypeRegistry` and public `bevy_remote::builtin_methods` handlers rather than hand-writing BRP query/get/mutate/schema behavior.
