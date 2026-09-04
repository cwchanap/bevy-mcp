# Generic Bevy MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one generic local MCP/plugin package that can launch and debug Bevy 0.19 applications through BRP/`bevy_brp_extras` and standalone `bevy_ecs::World` runtimes through a small companion bridge, with generic ECS inspection/mutation, runtime control, input, screenshots, diagnostics, logs, and plugin packaging.

**Architecture:** A Node/TypeScript stdio MCP server owns Cargo discovery, managed child processes, capability negotiation, MCP schemas, and translation to localhost JSON-RPC. Full Bevy applications reuse standard Bevy Remote Protocol plus `bevy_brp_extras`; the Rust `bevy_mcp_bridge` crate only composes those existing plugins and adds generic capabilities/time/world-stat methods. Standalone ECS hosts use the same crate's `EcsBridge`, which queues localhost JSON-RPC requests and applies a BRP-shaped reflected subset only when the host polls it with `&mut World`.

**Tech Stack:** Node.js >=20, TypeScript, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), Zod v4, Vitest, Rust 1.95+, Bevy/bevy_ecs 0.19.1, bevy_brp_extras 0.22.3, serde/serde_json, crossbeam-channel, tiny_http, GitHub Actions, Agent Plugins 1.0.0.

**Spec:** `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`

## Global Constraints

- Deliver all implementation tasks through one implementation PR; task commits stay on the same branch/PR.
- V1 supports Bevy / `bevy_ecs` 0.19.x only; do not add version adapters or compatibility shims.
- Use Rust edition 2024 and Rust >=1.95.0 because Bevy 0.19.1 requires that toolchain.
- Native runtime debugging only; no WASM/browser relay in v1.
- No Scorpius-, Caelum-, or other game-specific tools or semantic operations.
- Full Bevy apps must reuse Bevy BRP and `bevy_brp_extras` 0.22.3 for standard world operations, screenshot, input, diagnostics, and shutdown.
- Standalone ECS support must not require the host to hand ownership of its `World` or schedules to `bevy_app`.
- Runtime HTTP binds to `127.0.0.1` only and defaults to port 15702.
- Default runtime request timeout is 5 seconds; graceful shutdown grace is 2 seconds.
- Query results exposed to MCP default to 200 rows and are capped at 2000 rows.
- Debug output defaults to 200 lines and is capped at 5000 lines.
- The MCP server may manage only one child process at a time in v1.
- Do not add a daemon, database, web UI, monorepo framework, generic engine abstraction, replay system, test DSL, or scheduler profiler.

---

## Planned file structure

```text
Cargo.toml
LICENSE
README.md
package.json
package-lock.json
tsconfig.json
vitest.config.ts
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
    integration.ts
    integration.spec.ts
  packaging/
    metadata.ts
    metadata.spec.ts

crates/bevy-mcp-bridge/
  Cargo.toml
  src/
    lib.rs
    protocol.rs
    full.rs
    ecs.rs
    reflect.rs
    server.rs
  tests/
    ecs_bridge.rs
    full_plugin.rs

fixtures/full-app/
  Cargo.toml
  src/main.rs

fixtures/ecs-only/
  Cargo.toml
  src/main.rs

scripts/
  smoke-packed-cli.mjs
  integration.mjs

plugins/bevy-plugin/
  .mcp.json
  .codex-plugin/plugin.json
  .claude-plugin/plugin.json

.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
.github/workflows/ci.yml
```

`src/index.ts` stays bootstrap-only. Tool handlers are grouped by responsibility, not accumulated into one server file. The Rust bridge keeps transport, reflection, protocol, standalone host integration, and full-App composition separate so each can be understood/tested independently.

---

### Task 1: Bootstrap the package, Cargo workspace, Cargo discovery, and managed process lifecycle

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `Cargo.toml`
- Create: `LICENSE`
- Create: `src/index.ts`
- Create: `src/server.ts`
- Create: `src/project/cargo.ts`
- Create: `src/project/cargo.spec.ts`
- Create: `src/project/process-manager.ts`
- Create: `src/project/process-manager.spec.ts`
- Create: `src/tools/project.ts`

**Interfaces:**
- Produces `discoverBevyTargets(root: string): Promise<BevyTarget[]>`.
- Produces `resolveTarget(targets: BevyTarget[], selection: TargetSelection): BevyTarget`.
- Produces one `ProcessManager` instance with `run`, `stop`, `restart`, `status`, and `getOutput`.
- Produces `createServer(deps?: ServerDeps): McpServer`; later tasks register additional tools into this factory.

- [ ] **Step 1: Create package/workspace manifests with the pinned v1 baseline**

Use this package shape:

```json
{
  "name": "@cwchanap/bevy-plugin",
  "version": "0.1.0",
  "description": "Generic MCP server for inspecting, controlling, and debugging Bevy applications and standalone bevy_ecs runtimes.",
  "type": "module",
  "license": "MIT",
  "bin": {
    "bevy-plugin": "build/index.js"
  },
  "files": ["build", "plugin.json", "mcp.json"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepack": "npm run build",
    "smoke:packed": "node scripts/smoke-packed-cli.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  }
}
```

Root Cargo workspace:

```toml
[workspace]
members = [
  "crates/bevy-mcp-bridge",
  "fixtures/full-app",
  "fixtures/ecs-only",
]
default-members = ["crates/bevy-mcp-bridge"]
resolver = "3"
```

Run:

```bash
npm install
npm run typecheck
```

Expected: TypeScript compiles once the minimal bootstrap below is present.

- [ ] **Step 2: Write failing Cargo discovery tests**

`src/project/cargo.spec.ts` should inject a fake `execFile` result and lock exact target inference:

```ts
it('discovers full Bevy and standalone ECS executable targets', async () => {
  const metadata = metadataFixture({
    packages: [
      pkg('game', { bevy: '0.19.1' }, [bin('game')]),
      pkg('sim', { bevy_ecs: '0.19.1' }, [bin('sim'), example('bench')])
    ]
  });

  const targets = await discoverBevyTargets('/repo', fakeExec(metadata));

  expect(targets).toEqual([
    expect.objectContaining({ packageName: 'game', targetName: 'game', kind: 'bin', runtimeKind: 'full_bevy' }),
    expect.objectContaining({ packageName: 'sim', targetName: 'bench', kind: 'example', runtimeKind: 'standalone_ecs' }),
    expect.objectContaining({ packageName: 'sim', targetName: 'sim', kind: 'bin', runtimeKind: 'standalone_ecs' })
  ]);
});
```

Run:

```bash
npm test -- src/project/cargo.spec.ts
```

Expected: FAIL because `discoverBevyTargets` does not exist.

- [ ] **Step 3: Implement Cargo metadata discovery and exact target resolution**

Define:

```ts
export interface BevyTarget {
  packageName: string;
  manifestPath: string;
  targetName: string;
  kind: 'bin' | 'example';
  runtimeKind: 'full_bevy' | 'standalone_ecs' | 'unknown';
}

export interface TargetSelection {
  packageName: string;
  targetName: string;
  kind: 'bin' | 'example';
}
```

Invoke Cargo only as argv, never a shell string:

```ts
await execFileAsync('cargo', ['metadata', '--no-deps', '--format-version=1'], { cwd: root });
```

Infer `runtimeKind` only from direct dependency names. Sort by `packageName`, `kind`, then `targetName` for deterministic agent results.

Run the focused test again; expected PASS.

- [ ] **Step 4: Write failing process-manager tests for exact argv, bounded logs, and one-process ownership**

Tests must lock these commands:

```text
bin     -> cargo run -p <package> --bin <target> -- <app args...>
example -> cargo run -p <package> --example <target> -- <app args...>
```

They must also prove:

```ts
await expect(manager.run(spec)).resolves.toMatchObject({ running: true });
await expect(manager.run(spec)).rejects.toMatchObject({ code: 'process_already_running' });
expect(manager.getOutput({ lines: 2 }).lines).toEqual(['last-1', 'last']);
```

Run:

```bash
npm test -- src/project/process-manager.spec.ts
```

Expected: FAIL before `ProcessManager` exists.

- [ ] **Step 5: Implement `ProcessManager`**

Use `child_process.spawn('cargo', argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })`.

Store this launch spec for restart:

```ts
export interface LaunchSpec {
  root: string;
  target: BevyTarget;
  appArgs: string[];
  port: number;
}
```

Set both variables:

```ts
BEVY_MCP_PORT: String(spec.port),
BRP_EXTRAS_PORT: String(spec.port)
```

Maintain a 5000-line ring buffer and append stdout/stderr to one temp log file. `getOutput` clamps requested lines to 5000. Do not parse logs into a second structured log model.

- [ ] **Step 6: Register the project/process MCP tools and stdio bootstrap**

`src/index.ts` should remain:

```ts
#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

void serveStdio(() => createServer());
```

`src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';

export function createServer(deps: ServerDeps = createDefaultDeps()): McpServer {
  const server = new McpServer({ name: 'bevy-plugin', version: '0.1.0' });
  registerProjectTools(server, deps);
  return server;
}
```

Register `list_bevy_targets`, `run_bevy`, `stop_bevy`, `restart_bevy`, and `get_debug_output` with Zod v4 schemas. Mark stop/restart as destructive via MCP tool annotations.

- [ ] **Step 7: Verify and commit Task 1**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

Commit:

```bash
git add Cargo.toml LICENSE package*.json tsconfig.json vitest.config.ts src
 git commit -m "feat: add Bevy project and process foundation"
```

---

### Task 2: Add the localhost JSON-RPC client, capability negotiation, and read-only ECS tools

**Files:**
- Create: `src/runtime/client.ts`
- Create: `src/runtime/client.spec.ts`
- Create: `src/runtime/capabilities.ts`
- Create: `src/runtime/capabilities.spec.ts`
- Create: `src/runtime/errors.ts`
- Create: `src/tools/world.ts`
- Create: `src/tools/world.spec.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces `RuntimeClient.call<T>(method: string, params?: unknown): Promise<T>`.
- Produces `probeRuntime(port: number): Promise<RuntimeStatus>`.
- Produces normalized `RuntimeCapabilities` from the spec.
- Produces read-only tools: `get_runtime_status`, `list_components`, `list_resources`, `get_type_schema`, `query_entities`, `get_entity`, `get_resource`.

- [ ] **Step 1: Write failing JSON-RPC transport tests**

Lock exact request/response behavior with a local fake HTTP server:

```ts
const result = await client.call('world.list_components');
expect(receivedBody).toEqual({
  jsonrpc: '2.0',
  id: 1,
  method: 'world.list_components'
});
expect(result).toEqual(['fixture::Position']);
```

Also test JSON-RPC error, HTTP failure, malformed JSON, and abort after 5 seconds using fake timers/AbortController.

- [ ] **Step 2: Implement `RuntimeClient` and stable error mapping**

Use built-in `fetch`, not axios or another HTTP dependency:

```ts
export class RuntimeClient {
  constructor(
    private readonly port = 15702,
    private readonly timeoutMs = 5000
  ) {}

  async call<T>(method: string, params?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, ...(params === undefined ? {} : { params }) }),
        signal: controller.signal
      });
      // parse and normalize here
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

Map transport/runtime failures into the spec codes in `runtime/errors.ts`; handlers should never expose a rejected `fetch()` directly.

- [ ] **Step 3: Write failing capability-probe tests**

Cover three exact cases:

1. `bevy_mcp/capabilities` present -> trust/validate its result.
2. BRP-only runtime -> infer `ecsRead`, `ecsWrite`, registry support from `rpc.discover`; infer screenshot/input/diagnostics/shutdown from discovered `brp_extras/*` methods.
3. endpoint unreachable -> `runtime_unreachable`.

The fallback must not infer virtual-time support without `bevy_mcp/time_*` methods.

- [ ] **Step 4: Implement capability negotiation**

Define exactly:

```ts
export interface RuntimeCapabilities {
  process: boolean;
  ecsRead: boolean;
  ecsWrite: boolean;
  registrySchema: boolean;
  app: boolean;
  render: boolean;
  input: boolean;
  virtualTime: boolean;
  diagnostics: boolean;
  gracefulShutdown: boolean;
}

export interface RuntimeStatus {
  reachable: boolean;
  port: number;
  methods: string[];
  capabilities: RuntimeCapabilities;
}
```

`rpc.discover` parsing should collect method names from the OpenRPC document once, sort them, then capability-check by exact method name.

- [ ] **Step 5: Write failing world-tool translation tests**

For `query_entities`, pin the standard BRP request shape:

```ts
expect(client.call).toHaveBeenCalledWith('world.query', {
  data: {
    components: ['fixture::Position'],
    option: [],
    has: []
  },
  strict: false,
  filter: {
    with: ['fixture::Alive'],
    without: ['fixture::Hidden']
  }
});
```

The MCP handler then truncates returned rows to `limit` and returns:

```ts
{
  rows: response.slice(0, limit),
  matched: response.length,
  truncated: response.length > limit
}
```

Explicitly note in the handler description that standard BRP has no server-side row limit; the MCP limit prevents agent-context flooding but a BRP-only runtime still constructs the full remote response. The standalone bridge later stops scanning after `limit + 1` when using its native limited path.

- [ ] **Step 6: Implement read-only world tools**

Map:

```text
list_components -> world.list_components
list_resources  -> world.list_resources
get_type_schema -> registry.schema (filter returned map to requested full type path)
query_entities  -> world.query
get_entity      -> world.get_components
get_resource    -> world.get_resources
```

Before every call, check the relevant capability and return `unsupported_capability` rather than invoking a method known to be absent.

`query_entities` validation:

```ts
limit: z.number().int().min(1).max(2000).default(200)
```

- [ ] **Step 7: Register read/status tools, verify, and commit**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Commit:

```bash
git add src/runtime src/tools/world.* src/server.ts
 git commit -m "feat: add BRP runtime inspection tools"
```

---

### Task 3: Implement the full Bevy bridge plugin and generic time/world-stat methods

**Files:**
- Create: `crates/bevy-mcp-bridge/Cargo.toml`
- Create: `crates/bevy-mcp-bridge/src/lib.rs`
- Create: `crates/bevy-mcp-bridge/src/protocol.rs`
- Create: `crates/bevy-mcp-bridge/src/full.rs`
- Create: `crates/bevy-mcp-bridge/tests/full_plugin.rs`

**Interfaces:**
- Produces `bevy_mcp_bridge::BevyMcpPlugin` behind Cargo feature `full`.
- Registers `bevy_mcp/capabilities`, `bevy_mcp/world_stats`, `bevy_mcp/time_pause`, `bevy_mcp/time_resume`, `bevy_mcp/time_set_scale`.
- Full plugin composes `BrpExtrasPlugin`; it does not replace BRP or extras behavior.

- [ ] **Step 1: Create the bridge manifest with standalone-safe base dependencies**

Use:

```toml
[package]
name = "bevy_mcp_bridge"
version = "0.1.0"
edition = "2024"
rust-version = "1.95.0"
license = "MIT"

[features]
default = []
full = ["dep:bevy", "dep:bevy_brp_extras"]

[dependencies]
bevy_ecs = { version = "0.19.1", features = ["bevy_reflect", "serialize"] }
bevy_reflect = "0.19.1"
crossbeam-channel = "0.5"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tiny_http = "0.12"
bevy = { version = "0.19.1", default-features = false, features = ["bevy_remote", "png"], optional = true }
bevy_brp_extras = { version = "0.22.3", optional = true }
```

The `bevy` dependency is optional so standalone users do not acquire a full Bevy application dependency. Enabling the `full` feature also unifies the host's required `bevy_remote`/`png` features.

- [ ] **Step 2: Write RED full-plugin tests**

Use a minimal `App` without a window for method-level tests:

```rust
#[test]
fn capabilities_report_full_app_features() {
    let mut app = App::new();
    app.add_plugins(BevyMcpPlugin);
    let value = call_registered_method(&mut app, "bevy_mcp/capabilities", None).unwrap();
    assert_eq!(value["app"], true);
    assert_eq!(value["render"], true);
    assert_eq!(value["input"], true);
    assert_eq!(value["virtualTime"], true);
}
```

Also assert pause/resume/set-scale changes `Time<Virtual>` and rejects zero/negative/non-finite scales.

Run:

```bash
cargo test -p bevy_mcp_bridge --features full --test full_plugin
```

Expected: FAIL because the plugin/methods do not exist.

- [ ] **Step 3: Implement `BevyMcpPlugin` as composition only**

`full.rs` should add `BrpExtrasPlugin` and register custom generic methods through `RemotePlugin`/`RemoteMethods` using public Bevy remote APIs. The time handlers should be exclusive world handlers of this shape:

```rust
fn pause_time(In(_: In<Option<Value>>), world: &mut World) -> BrpResult {
    world.resource_mut::<Time<Virtual>>().pause();
    Ok(time_status(world))
}
```

Do not copy screenshot/input/diagnostics implementations from `bevy_brp_extras`.

Port handling:

```rust
let port = std::env::var("BEVY_MCP_PORT")
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(15702);
```

Pass it to `BrpExtrasPlugin::with_port(port)` unless an existing BRP HTTP plugin already owns the transport; extras already handles composition/warnings.

- [ ] **Step 4: Implement cheap world statistics**

Return only the spec contract:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorldStats {
    entity_count: usize,
    archetype_count: usize,
    registered_component_count: usize,
    registered_resource_count: usize,
    component_entity_counts: Vec<ComponentCount>,
}
```

Walk component metadata/archetypes once per explicit request; sort component rows by descending count then full type path. Do not add periodic sampling.

- [ ] **Step 5: Verify Task 3**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bevy_mcp_bridge --features full
cargo clippy -p bevy_mcp_bridge --all-targets --features full -- -D warnings
```

Expected: PASS.

Commit:

```bash
git add crates/bevy-mcp-bridge Cargo.toml
 git commit -m "feat: add full Bevy debug bridge"
```

---

### Task 4: Add generic ECS mutation, time control, input, screenshot, diagnostics, and raw remote tools to the MCP

**Files:**
- Create: `src/tools/control.ts`
- Create: `src/tools/control.spec.ts`
- Create: `src/tools/visual.ts`
- Create: `src/tools/visual.spec.ts`
- Create: `src/tools/diagnostics.ts`
- Create: `src/tools/diagnostics.spec.ts`
- Modify: `src/tools/world.ts`
- Modify: `src/tools/world.spec.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Adds mutation tools from the spec.
- Adds `control_time`, `send_keys`, `type_text`, `mouse_input`, `capture_screenshot`, `shutdown_runtime`.
- Adds `get_diagnostics`, `get_world_stats`, `list_remote_methods`, `call_remote_method`.

- [ ] **Step 1: Write failing mutation translation tests**

Pin mappings:

```text
spawn_entity     -> world.spawn_entity
remove_entity    -> world.despawn_entity
set_components   -> world.insert_components
mutate_component -> world.mutate_components
remove_components-> world.remove_components
set_resource     -> world.insert_resources
mutate_resource  -> world.mutate_resources
remove_resource  -> world.remove_resources
```

For path mutation:

```ts
await mutateComponent({
  entity: 42,
  component: 'fixture::Health',
  path: '.current',
  value: 5
});
```

must call:

```ts
client.call('world.mutate_components', {
  entity: 42,
  component: 'fixture::Health',
  path: '.current',
  value: 5
});
```

Run focused tests; expected RED.

- [ ] **Step 2: Implement mutations with destructive MCP annotations**

All world-write tools check `ecsWrite`. Mark remove/despawn/mutate tools `destructiveHint: true`; reads remain `readOnlyHint: true`.

Do not add a transaction/bulk-patch abstraction. One MCP call maps to one BRP mutation request.

- [ ] **Step 3: Write failing time/input tool tests**

`control_time` must map exactly:

```text
pause     -> bevy_mcp/time_pause
resume    -> bevy_mcp/time_resume
set_scale -> bevy_mcp/time_set_scale { scale }
```

`mouse_input` action mapping:

```text
move         -> brp_extras/move_mouse
click        -> brp_extras/click_mouse
double_click -> brp_extras/double_click_mouse
button_down  -> brp_extras/send_mouse_button { pressed: true }
button_up    -> brp_extras/send_mouse_button { pressed: false }
drag         -> brp_extras/drag_mouse
scroll       -> brp_extras/scroll_mouse
```

Require `input` capability before keyboard/mouse calls and `virtualTime` before time calls.

- [ ] **Step 4: Implement control tools**

Zod time schema:

```ts
const timeControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), port: z.number().int().optional() }),
  z.object({ action: z.literal('resume'), port: z.number().int().optional() }),
  z.object({ action: z.literal('set_scale'), scale: z.number().positive().finite(), port: z.number().int().optional() })
]);
```

Keep `send_keys` and `type_text` separate tools because their semantics differ.

- [ ] **Step 5: Write failing screenshot payload/cleanup tests**

Fake `brp_extras/screenshot` by writing a tiny PNG to the requested temp path. Assert MCP output is an image block and the temp file is removed after read:

```ts
expect(result.content[0]).toMatchObject({
  type: 'image',
  mimeType: 'image/png'
});
expect(existsSync(capturedPath)).toBe(false);
```

Also test standalone/no-render capability returns `unsupported_capability` without creating a temp path.

- [ ] **Step 6: Implement `capture_screenshot`**

Create the path under `os.tmpdir()` using a random filename owned by the MCP. Call:

```ts
await client.call('brp_extras/screenshot', {
  path,
  ...(cameraEntity === undefined ? {} : { camera: cameraEntity }),
  ...(entity === undefined ? {} : { entity }),
  ...(padding === undefined ? {} : { padding })
});
```

Read the PNG, return base64 MCP image content, and delete in `finally`.

Do not accept a caller-supplied screenshot path.

- [ ] **Step 7: Implement diagnostics and protocol tools**

Mappings:

```text
get_diagnostics    -> brp_extras/get_diagnostics
get_world_stats    -> bevy_mcp/world_stats
list_remote_methods-> rpc.discover (normalized to names)
call_remote_method -> raw RuntimeClient.call(method, params)
shutdown_runtime   -> brp_extras/shutdown
```

`call_remote_method` validates `method` as a non-empty string and requires it to appear in the current `rpc.discover` result before calling it; return `remote_method_not_found` otherwise.

- [ ] **Step 8: Verify and commit Task 4**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Commit:

```bash
git add src/tools src/server.ts
 git commit -m "feat: add generic Bevy control and diagnostics"
```

---

### Task 5: Implement the standalone `EcsBridge` transport and reflected BRP-shaped world subset

**Files:**
- Create: `crates/bevy-mcp-bridge/src/ecs.rs`
- Create: `crates/bevy-mcp-bridge/src/reflect.rs`
- Create: `crates/bevy-mcp-bridge/src/server.rs`
- Expand: `crates/bevy-mcp-bridge/src/protocol.rs`
- Modify: `crates/bevy-mcp-bridge/src/lib.rs`
- Create: `crates/bevy-mcp-bridge/tests/ecs_bridge.rs`

**Interfaces:**
- Produces `EcsBridge::new()`, `EcsBridge::with_port(u16)`, `register_component<T>()`, `register_resource<T>()`, and `poll(&mut World) -> usize`.
- Standalone transport exposes the required method names from the spec and `rpc.discover` is authoritative.
- `EcsBridge` never owns the caller's `World`.

- [ ] **Step 1: Write RED registration/list/get tests**

Fixture types:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct Position { x: f32, y: f32 }

#[derive(Resource, Reflect)]
#[reflect(Resource)]
struct Clock { minute: u32 }
```

Test API:

```rust
let mut bridge = EcsBridge::without_server_for_test();
bridge.register_component::<Position>();
bridge.register_resource::<Clock>();

let mut world = World::new();
let entity = world.spawn(Position { x: 1.0, y: 2.0 }).id();
world.insert_resource(Clock { minute: 90 });

assert_eq!(bridge.call_for_test(&mut world, "world.list_components", None)?, json!([type_name::<Position>()]));
```

Run:

```bash
cargo test -p bevy_mcp_bridge --test ecs_bridge
```

Expected: FAIL before `EcsBridge` exists.

- [ ] **Step 2: Implement reflection registration and typed JSON conversion**

`EcsBridge` owns:

```rust
pub struct EcsBridge {
    registry: TypeRegistry,
    server: Option<BridgeServer>,
}
```

Registration:

```rust
pub fn register_component<T>(&mut self)
where
    T: Component + Reflect + GetTypeRegistration + FromReflect,
{
    self.registry.register::<T>();
    self.registry.register_type_data::<T, ReflectComponent>();
}
```

Do the equivalent for `ReflectResource`.

Serialization of a known reflected value uses `TypedReflectSerializer`; deserialization of incoming JSON uses the matching `TypeRegistration` plus `TypedReflectDeserializer`. Keep those conversions in `reflect.rs`, not spread through endpoint handlers.

- [ ] **Step 3: Implement read/query methods and query row limit**

Support exactly:

```text
world.list_components
world.list_resources
world.get_components
world.get_resources
world.query
registry.schema
```

For standalone `world.query`, parse the same `data.components`, `filter.with`, and `filter.without` shape used by the MCP. Iterate `world.iter_entities()` and use registered `ReflectComponent::contains/reflect` to filter/read values.

The bridge accepts an optional nonstandard top-level `bevy_mcp_limit` added by our MCP adapter for standalone mode. Stop after `limit + 1` matching entities and return a response wrapper understood only by our adapter:

```json
{
  "rows": [...],
  "truncated": true
}
```

For raw standard `world.query` calls with no `bevy_mcp_limit`, return the standard BRP-style row array. This preserves raw protocol usefulness while giving the normal MCP a server-side bound for 200k-ECS projects.

`registry.schema` needs only the reflected type information consumed by `get_type_schema`: full type path, short path, kind, field/property names/types, and whether the registration carries component/resource reflection data. Do not import `bevy_remote` solely to copy its entire schema exporter; the MCP normalizes both Bevy BRP schema and standalone schema into its own response.

- [ ] **Step 4: Write RED mutation tests**

Cover:

```rust
world.spawn_entity
world.despawn_entity
world.insert_components
world.remove_components
world.mutate_components
world.insert_resources
world.remove_resources
world.mutate_resources
```

Mutation test must prove nested path application rather than replacing the whole component:

```rust
bridge.call_for_test(
    &mut world,
    "world.mutate_components",
    Some(json!({
        "entity": entity.to_bits(),
        "component": type_name::<Position>(),
        "path": ".x",
        "value": 9.0
    }))
)?;
assert_eq!(world.get::<Position>(entity).unwrap().x, 9.0);
```

- [ ] **Step 5: Implement mutation handlers**

Resolve full type path -> `TypeRegistration` -> `ReflectComponent`/`ReflectResource`. Convert incoming JSON to a dynamic reflected value, then use Bevy reflection APIs:

```text
insert -> ReflectComponent::insert / reflected resource insert
remove -> ReflectComponent::remove / resource removal
whole replacement -> apply_or_insert/insert
path mutation -> reflect_mut + GetPath/ReflectPath mutation + apply converted field value
```

Return `remote_error`-shaped JSON-RPC errors for unknown type/entity/path or immutable component cases; never panic on client input.

- [ ] **Step 6: Write RED HTTP/polling tests**

Start `EcsBridge::with_port(0)` in test mode so the OS assigns a port. Send a real HTTP JSON-RPC request from a helper thread, deliberately do not poll first, then poll once and assert the waiting HTTP request completes.

A second test must set the bridge request timeout to a short test value and assert a request returns `runtime_not_polling` when the host never calls `poll`.

- [ ] **Step 7: Implement loopback HTTP thread and channels**

Use `tiny_http` and `crossbeam_channel`:

```text
HTTP thread -> RequestEnvelope channel -> EcsBridge::poll(&mut World)
HTTP thread <- oneshot response channel <- handler result
```

Bind only `127.0.0.1`. Production default port is 15702 or `BEVY_MCP_PORT`.

`poll` drains currently queued requests and returns how many it processed; it never blocks the simulation thread waiting for HTTP.

- [ ] **Step 8: Implement standalone capabilities/world stats/rpc discovery**

Advertise:

```json
{
  "process": true,
  "ecsRead": true,
  "ecsWrite": true,
  "registrySchema": true,
  "app": false,
  "render": false,
  "input": false,
  "virtualTime": false,
  "diagnostics": true,
  "gracefulShutdown": false
}
```

`rpc.discover` must list only implemented methods; no screenshot/input/time methods.

- [ ] **Step 9: Verify and commit Task 5**

Run:

```bash
cargo fmt --all -- --check
cargo test -p bevy_mcp_bridge
cargo clippy -p bevy_mcp_bridge --all-targets -- -D warnings
```

Commit:

```bash
git add crates/bevy-mcp-bridge
 git commit -m "feat: add standalone ECS debug bridge"
```

---

### Task 6: Make the MCP adapter use the standalone limited-query path and add bridge-status/dependency setup tools

**Files:**
- Create: `src/tools/integration.ts`
- Create: `src/tools/integration.spec.ts`
- Modify: `src/runtime/capabilities.ts`
- Modify: `src/tools/world.ts`
- Modify: `src/tools/world.spec.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Adds `get_bridge_status` and `install_bridge_dependency`.
- Adds runtime kind/version metadata to `RuntimeStatus` when `bevy_mcp/capabilities` is available.
- Uses `bevy_mcp_limit` for standalone bridge queries without changing the public MCP query schema.

- [ ] **Step 1: Extend capabilities with bridge metadata**

The bridge capability response includes:

```json
{
  "bridge": {
    "name": "bevy_mcp_bridge",
    "version": "0.1.0",
    "runtimeKind": "full_bevy"
  },
  "capabilities": { "...": true }
}
```

Standalone uses `runtimeKind: "standalone_ecs"`.

Update TypeScript probe tests to distinguish these from BRP-only mode.

- [ ] **Step 2: Add server-side query limiting only for standalone bridge**

When `runtimeKind === 'standalone_ecs'`, send:

```ts
{
  data: { components, option: [], has: [] },
  strict: false,
  filter: { with, without },
  bevy_mcp_limit: limit
}
```

Normalize its `{ rows, truncated }` wrapper back to the public `query_entities` result. Full Bevy/BRP continues standard `world.query` + client truncation.

- [ ] **Step 3: Write failing bridge-status tests**

Status states must be exactly:

```text
full_bridge
brp_only
standalone_bridge
dependency_only
not_configured
version_mismatch
```

Use Cargo metadata plus live capability probing. `version_mismatch` means an installed `bevy_mcp_bridge` version outside the single supported v1 version line; do not add compatibility behavior.

- [ ] **Step 4: Implement `get_bridge_status`**

Do not parse arbitrary Rust source. Inspect selected package dependencies through Cargo metadata and the live endpoint when reachable.

Return an `integrationSnippet` when code wiring is still required.

Full Bevy snippet:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

Standalone snippet:

```rust
let mut debug = bevy_mcp_bridge::EcsBridge::new()?;
debug.register_component::<YourComponent>();
debug.register_resource::<YourResource>();
// poll at a safe simulation boundary:
debug.poll(&mut world);
```

The placeholder type names above are explanatory text returned to the user, not generated source written into the project.

- [ ] **Step 5: Write failing dependency-install tests**

Mock `cargo add` and assert exact argv:

Full Bevy:

```text
cargo add bevy_mcp_bridge@0.1.0 --features full -p <package>
```

Standalone:

```text
cargo add bevy_mcp_bridge@0.1.0 -p <package>
```

No direct `Cargo.toml` string editing.

- [ ] **Step 6: Implement `install_bridge_dependency`**

Require an exact target/package selection and detected runtime kind. Run `cargo add` through argv. Do not rewrite Rust source automatically.

After installation, return the same explicit integration snippet from `get_bridge_status`.

- [ ] **Step 7: Verify and commit Task 6**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Commit:

```bash
git add src/runtime src/tools src/server.ts
 git commit -m "feat: add bridge integration workflow"
```

---

### Task 7: Add full-Bevy and standalone-ECS native integration fixtures and one cross-adapter smoke journey

**Files:**
- Create: `fixtures/full-app/Cargo.toml`
- Create: `fixtures/full-app/src/main.rs`
- Create: `fixtures/ecs-only/Cargo.toml`
- Create: `fixtures/ecs-only/src/main.rs`
- Create: `scripts/integration.mjs`
- Modify: `package.json`

**Interfaces:**
- Full fixture exposes a reflected component/resource, visible window/UI target, input-observable state, and `BevyMcpPlugin`.
- ECS-only fixture exposes the same conceptual reflected component/resource but owns only `World + Schedule + EcsBridge`.
- `npm run test:integration` launches/probes both and exits cleanly.

- [ ] **Step 1: Create the standalone fixture first**

Use a tiny loop:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct Counter { value: i32 }

#[derive(Resource, Reflect)]
#[reflect(Resource)]
struct TickCount(u64);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut world = World::new();
    world.insert_resource(TickCount(0));
    world.spawn(Counter { value: 1 });

    let mut bridge = EcsBridge::new()?;
    bridge.register_component::<Counter>();
    bridge.register_resource::<TickCount>();

    loop {
        bridge.poll(&mut world);
        std::thread::sleep(Duration::from_millis(5));
    }
}
```

The integration script launches it, waits for the endpoint, queries `Counter`, mutates it, reads it back, checks world stats, then kills the managed process because standalone advertises no graceful shutdown.

- [ ] **Step 2: Create the full Bevy fixture**

Build one small 2D window with a reflected `Counter`, a `Text`/UI indicator, and keyboard/mouse systems that print recognizable log lines when input arrives. Add:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
.register_type::<Counter>()
```

Keep assets embedded/generated; do not introduce fixture asset files.

- [ ] **Step 3: Implement the full integration journey**

`scripts/integration.mjs` should use the compiled TypeScript modules directly rather than shelling through an agent client. Sequence:

```text
list target
launch full fixture
wait for reachable capabilities
query Counter
mutate Counter and verify
pause time
set scale
resume time
send keyboard input and observe log marker
send mouse click and observe log marker
capture screenshot to MCP-image conversion helper and verify PNG signature/dimensions
get diagnostics
get world stats
shutdown runtime and verify child exits
```

Then run the standalone journey from Step 1.

- [ ] **Step 4: Run the integration smoke under a display server**

Add:

```json
"test:integration": "node scripts/integration.mjs"
```

Locally on macOS/Windows run directly. Linux CI uses:

```bash
xvfb-run -a npm run test:integration
```

The script must use random free ports so retries/parallel CI jobs do not contend for 15702.

- [ ] **Step 5: Run complete Rust/Node gates and commit Task 7**

Run:

```bash
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
xvfb-run -a npm run test:integration   # Linux; run directly elsewhere
```

Commit:

```bash
git add fixtures scripts package*.json Cargo.toml
 git commit -m "test: cover full Bevy and ECS bridge flows"
```

---

### Task 8: Add Agent Plugins/Codex/Claude packaging, README, packed smoke, and CI

**Files:**
- Create: `plugin.json`
- Create: `mcp.json`
- Create: `plugins/bevy-plugin/.mcp.json`
- Create: `plugins/bevy-plugin/.codex-plugin/plugin.json`
- Create: `plugins/bevy-plugin/.claude-plugin/plugin.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `src/packaging/metadata.ts`
- Create: `src/packaging/metadata.spec.ts`
- Create: `scripts/smoke-packed-cli.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Every wrapper invokes one npm binary/version: `npx -y @cwchanap/bevy-plugin@0.1.0`.
- Root `plugin.json` and `mcp.json` conform to Agent Plugins 1.0.0.
- Packed npm smoke proves installable artifact contents/CLI startup.

- [ ] **Step 1: Write metadata-consistency tests before manifests**

Test one helper that loads all JSON manifests and asserts:

```ts
expect(allReferencedPackageVersions()).toEqual(new Set(['0.1.0']));
expect(allServerCommands()).toEqual(new Set(['npx']));
expect(allPackageNames()).toEqual(new Set(['@cwchanap/bevy-plugin']));
```

Run:

```bash
npm test -- src/packaging/metadata.spec.ts
```

Expected: RED because metadata files do not exist.

- [ ] **Step 2: Add portable Agent Plugins metadata**

Root `plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "bevy-plugin",
  "version": "0.1.0",
  "description": "Connect AI coding agents to local Bevy and bevy_ecs projects for generic runtime debugging.",
  "author": { "name": "cwchanap", "url": "https://github.com/cwchanap" },
  "homepage": "https://github.com/cwchanap/bevy-mcp",
  "repository": "https://github.com/cwchanap/bevy-mcp",
  "license": "MIT",
  "keywords": ["bevy", "mcp", "agent-plugin", "game-development", "debugging"]
}
```

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

- [ ] **Step 3: Mirror the current Godot plugin wrapper layout**

Use the same structural convention already used in `cwchanap/godot-mcp`:

```text
plugins/bevy-plugin/.mcp.json
plugins/bevy-plugin/.codex-plugin/plugin.json
plugins/bevy-plugin/.claude-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

Do not introduce a second MCP implementation or client-specific JS entrypoint.

- [ ] **Step 4: Implement packed CLI smoke**

`scripts/smoke-packed-cli.mjs` should:

1. run `npm pack --json`;
2. unpack into a temp directory;
3. assert `build/index.js`, `plugin.json`, and `mcp.json` exist;
4. spawn the packed `bevy-plugin` binary;
5. perform an MCP stdio initialize/list-tools exchange or use the MCP Inspector-compatible client helper;
6. assert representative tools `list_bevy_targets`, `query_entities`, and `capture_screenshot` are advertised;
7. terminate the child and delete the tarball/temp directory.

Do not treat `--help` as sufficient: the binary is an MCP stdio server, so smoke the protocol surface.

- [ ] **Step 5: Rewrite README for generic v1 usage**

README sections, in order:

```text
What it is
Features
Requirements / supported Bevy 0.19.x
Quick start (npx)
Codex plugin
Claude Code plugin
Agent Plugins / Pi-compatible installation
Full Bevy integration
Standalone bevy_ecs integration
Reflection registration
Tool reference by category
Localhost/debug security note
Development / tests
```

Full integration snippet must show `BevyMcpPlugin`; standalone snippet must show explicit component/resource registration and `poll(&mut world)`. Do not mention Scorpius or Caelum in the public README.

- [ ] **Step 6: Add CI**

One workflow on pull request/push:

```yaml
- run: npm ci
- run: npm run typecheck
- run: npm test
- run: npm run build
- run: npm run smoke:packed
- run: cargo fmt --all -- --check
- run: cargo test --workspace
- run: cargo clippy --workspace --all-targets --all-features -- -D warnings
- run: xvfb-run -a npm run test:integration
```

Install the Rust toolchain satisfying `1.95.0` and Linux packages needed by Bevy/xvfb. Cache Cargo/npm normally; do not add a custom build cache service.

- [ ] **Step 7: Final scope/leftover verification**

Run:

```bash
rg -n "Scorpius|Caelum|battle_snapshot|transport_demand" . --glob '!docs/superpowers/**'
```

Expected: no matches in production/package/docs README surface.

Run:

```bash
rg -n "wasm|WebSocket|remote host|0\.18|0\.17" src crates README.md package.json plugin.json mcp.json
```

Expected: only explicit statements that WASM/older Bevy versions are unsupported, not implementation code or compatibility branches.

Then run the full gate again:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:packed
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
xvfb-run -a npm run test:integration
```

- [ ] **Step 8: Commit Task 8 and prepare the single implementation PR**

Commit:

```bash
git add README.md package*.json plugin.json mcp.json plugins .agents .claude-plugin src/packaging scripts/smoke-packed-cli.mjs .github
 git commit -m "docs: package generic Bevy MCP plugin"
```

The implementation branch should then contain all Tasks 1-8 and open **one** PR. Do not split bridge, MCP, packaging, or verification into separate PRs.

---

## Plan self-review checklist

Before implementation begins, verify these mappings once:

| Spec requirement | Owning task |
| --- | --- |
| Cargo discovery/process/logs | Task 1 |
| JSON-RPC + capability negotiation | Task 2 |
| Generic ECS reads/schema/query | Task 2 + Task 5 standalone parity |
| Full Bevy BRP/extras reuse | Task 3 |
| Virtual-time/world stats | Task 3 + Task 4 |
| ECS mutation | Task 4 + Task 5 standalone parity |
| Keyboard/mouse/screenshot/diagnostics/shutdown | Task 4 |
| Standalone caller-owned World bridge | Task 5 |
| Bounded standalone query | Task 5 + Task 6 |
| Bridge status/dependency install without source rewriting | Task 6 |
| Full native composition smoke | Task 7 |
| Standalone ECS smoke | Task 7 |
| Agent Plugins/Codex/Claude packaging | Task 8 |
| README/security/version scope | Task 8 |
| No game-specific operations | Global constraints + Task 8 leftover scan |
| One implementation PR | Global constraints + Task 8 |

No task is allowed to introduce application-specific tool names to satisfy fixture tests; fixtures must use generic reflected types only.
