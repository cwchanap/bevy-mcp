# Generic Bevy MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one generic local MCP/plugin package that launches and debugs Bevy 0.19 applications through official BRP plus `bevy_brp_extras`, with generic reflected ECS inspection/mutation, runtime control, input, validated screenshots, diagnostics, logs, and agent-plugin packaging.

**Architecture:** A Node/TypeScript stdio MCP server owns Cargo discovery, one managed child process, capability negotiation, stable MCP schemas, and localhost JSON-RPC translation. Full Bevy applications reuse official BRP and `bevy_brp_extras`; the small Rust `bevy-mcp-bridge` crate only composes `BrpExtrasPlugin` and registers repository-owned `bevy_mcp/world_stats` and `bevy_mcp/time_control` methods. Standalone `bevy_ecs::World` transport is deferred until a real consumer exists; when added, it must reuse `bevy_remote::builtin_methods` rather than implement a second BRP.

**Tech Stack:** Node.js >=20, TypeScript 6, MCP TypeScript SDK v2 (`@modelcontextprotocol/server` + client dev dependency), Zod v4, Vitest, Rust >=1.95, Bevy 0.19.1, `bevy_brp_extras` 0.22.3, GitHub Actions, Agent Plugins 1.0.0.

**Spec:** `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`

## Global Constraints

- Deliver all implementation tasks on existing draft PR #1 and branch `agent/generic-bevy-mcp-design`; do not open a second implementation PR.
- V1 supports Bevy 0.19.x only; do not add version adapters or compatibility shims.
- Use Rust edition 2024 and Rust >=1.95.0 for repository-owned Rust code.
- Native runtime debugging only; no WASM/browser relay in v1.
- No Scorpius-, Caelum-, or other game-specific tools or semantic operations.
- No standalone `bevy_ecs` transport in v1.
- Full Bevy apps must reuse official BRP and `bevy_brp_extras` 0.22.3 for world operations, screenshot, input, diagnostics, and shutdown.
- Reflection is the only generic component/resource inspection boundary.
- Runtime requests connect to `127.0.0.1` only, defaulting to port 15702.
- Default runtime request timeout is 5 seconds; graceful shutdown grace is 2 seconds.
- `query_entities` returns at most 200 rows by default and 2000 rows maximum; this is an MCP response cap, not a private BRP query parameter.
- Debug output returns 200 lines by default and 5000 maximum.
- Screenshot PNG payloads are capped at 16 MiB before base64 encoding.
- The MCP server manages at most one child process at a time in v1.
- Do not add a daemon, database, web UI, generic engine abstraction, retry framework, replay system, test DSL, or scheduler profiler.
- Do not automatically edit `Cargo.toml` or Rust source; setup tools return status plus copyable Git-dependency/plugin snippets.

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

Cargo.toml                         # created with Task 3, when all members exist
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

`src/index.ts` stays bootstrap-only. There is no `reflect.rs`, standalone HTTP server, ECS-only fixture, or second protocol implementation in v1.

---

### Task 1: Bootstrap the npm MCP, Cargo discovery, and one managed process

**Files:**
- Create: `package.json`
- Create: `package-lock.json` through `npm install`
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
- Produces `discoverBevyTargets(root: string): Promise<BevyTarget[]>`.
- Produces `resolveTarget(targets: BevyTarget[], selection: TargetSelection): BevyTarget`.
- Produces `buildTarget(spec: BuildSpec): Promise<BuildResult>`.
- Produces one `ProcessManager` with `run`, `stop`, `restart`, `status`, and `getOutput`.
- Produces `createServer(deps?: ServerDeps): McpServer`; later tasks add registrations to this factory.

- [ ] **Step 1: Create the npm manifest and TypeScript config**

Use this package shape:

```json
{
  "name": "@cwchanap/bevy-plugin",
  "version": "0.1.0",
  "description": "Generic MCP server for inspecting, controlling, and debugging Bevy applications.",
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

`tsconfig.json` must include Node types explicitly:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "build",
    "strict": true,
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

Run:

```bash
npm install
```

Expected: `package-lock.json` is generated and both MCP v2 packages resolve.

- [ ] **Step 2: Write failing Cargo discovery tests**

`src/project/cargo.spec.ts` must lock executable-target discovery without parsing Rust source:

```ts
it('discovers Bevy bins and examples from cargo metadata', async () => {
  const metadata = metadataFixture({
    packages: [
      pkg('game', { bevy: '0.19.1' }, [bin('game'), example('sandbox')]),
      pkg('utility', {}, [bin('utility')])
    ]
  });

  const targets = await discoverBevyTargets('/repo', fakeExec(metadata));

  expect(targets).toEqual([
    expect.objectContaining({ packageName: 'game', targetName: 'game', kind: 'bin', runtimeKind: 'full_bevy' }),
    expect.objectContaining({ packageName: 'game', targetName: 'sandbox', kind: 'example', runtimeKind: 'full_bevy' }),
    expect.objectContaining({ packageName: 'utility', targetName: 'utility', kind: 'bin', runtimeKind: 'unknown' })
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
  runtimeKind: 'full_bevy' | 'unknown';
}

export interface TargetSelection {
  packageName: string;
  targetName: string;
  kind: 'bin' | 'example';
}
```

Invoke Cargo as argv:

```ts
await execFileAsync('cargo', ['metadata', '--no-deps', '--format-version=1'], { cwd: root });
```

Infer `full_bevy` only when the package directly depends on `bevy` or `bevy_brp_extras`. Sort by package, kind, target.

Run the focused test again; expected PASS.

- [ ] **Step 4: Write failing build/process tests**

Lock exact argv:

```text
build bin     -> cargo build -p <package> --bin <target>
build example -> cargo build -p <package> --example <target>
run bin       -> cargo run -p <package> --bin <target> -- <app args...>
run example   -> cargo run -p <package> --example <target> -- <app args...>
```

Also prove one-process ownership and bounded output:

```ts
await manager.run(spec);
await expect(manager.run(spec)).rejects.toMatchObject({ code: 'process_already_running' });
expect(manager.getOutput({ lines: 2 }).lines).toEqual(['last-1', 'last']);
```

Run:

```bash
npm test -- src/project/process-manager.spec.ts
```

Expected: FAIL before the implementation exists.

- [ ] **Step 5: Implement build and process management**

`buildTarget` uses `execFile('cargo', argv)` with no shell and returns:

```ts
export interface BuildResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

`ProcessManager.run` uses:

```ts
spawn('cargo', argv, {
  cwd: spec.root,
  env: {
    ...process.env,
    BEVY_MCP_PORT: String(spec.port),
    BRP_EXTRAS_PORT: String(spec.port)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
```

Maintain a 5000-line ring buffer and append raw stdout/stderr to one temp log file. `getOutput` clamps requested lines to 5000.

- [ ] **Step 6: Register project/process tools and stdio bootstrap**

Register:

```text
list_bevy_targets
build_bevy
run_bevy
stop_bevy
restart_bevy
get_debug_output
```

`src/index.ts` stays:

```ts
#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

void serveStdio(() => createServer());
```

`stop_bevy` initially terminates the managed child; Task 4 upgrades it to try remote graceful shutdown first.

- [ ] **Step 7: Verify and commit Task 1**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS.

Commit:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts LICENSE src
 git commit -m "feat: add Bevy project and process foundation"
```

---

### Task 2: Add BRP transport, capability discovery, and typed generic ECS tools

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
- Produces `RuntimeClient.call<T>(method: string, params?: unknown): Promise<T>`.
- Produces `probeRuntime(port: number, managed: boolean): Promise<RuntimeStatus>`.
- Produces all normalized read contracts from the design spec.
- Produces generic ECS read/write tools plus `list_remote_methods` and `call_remote_method`.

- [ ] **Step 1: Write failing JSON-RPC client tests**

Use a local fake HTTP server and lock the request:

```ts
await client.call('world.list_components');
expect(receivedBody).toEqual({
  jsonrpc: '2.0',
  id: 1,
  method: 'world.list_components'
});
```

Cover:

- successful `result`;
- JSON-RPC `error` preservation;
- non-2xx HTTP;
- malformed JSON;
- timeout -> `runtime_unreachable`.

Run:

```bash
npm test -- src/runtime/client.spec.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement `RuntimeClient`**

Use built-in `fetch` only:

```ts
export class RuntimeClient {
  constructor(
    private readonly port = 15702,
    private readonly timeoutMs = 5000
  ) {}

  async call<T>(method: string, params?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: nextRequestId(),
          method,
          ...(params === undefined ? {} : { params })
        }),
        signal: controller.signal
      });
      return parseJsonRpcResponse<T>(response);
    } finally {
      clearTimeout(timer);
    }
  }
}
```

Normalize failures into the spec's small error set; keep BRP code/message in `remote_error.details`.

- [ ] **Step 3: Pin the agent-facing read result types before tool implementation**

`src/runtime/types.ts` must define exactly:

```ts
export interface ListComponentsResult { components: string[] }
export interface ListResourcesResult { resources: string[] }
export interface TypeSchemaResult { schema: Record<string, unknown> }

export interface ComponentReadError {
  message: string;
  code?: number;
}

export interface EntitySnapshot {
  entity: number;
  components: Record<string, unknown>;
  errors: Record<string, ComponentReadError>;
}

export interface ResourceSnapshot {
  resource: string;
  value: unknown;
}

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

Do not add a second schema model for `registry.schema`; wrap the returned BRP object under `schema`.

- [ ] **Step 4: Write failing capability tests derived only from `rpc.discover`**

Given discovered methods, prove:

```ts
expect(deriveCapabilities(methods, true)).toEqual({
  process: true,
  ecsRead: true,
  ecsWrite: true,
  registrySchema: true,
  app: true,
  render: true,
  input: true,
  virtualTime: true,
  diagnostics: true,
  gracefulShutdown: true
});
```

Then remove `brp_extras/screenshot`, `brp_extras/get_diagnostics`, and `bevy_mcp/time_control` and prove only their matching flags turn false.

No bridge-owned method may hardcode render/input/diagnostics flags.

- [ ] **Step 5: Implement `rpc.discover` parsing and `get_runtime_status`**

Define:

```ts
export interface RuntimeStatus {
  reachable: boolean;
  port: number;
  methods: string[];
  capabilities: RuntimeCapabilities;
}
```

Collect method names from the OpenRPC document, sort them, and derive capabilities by exact name.

`app` is true for a reachable BRP endpoint. `process` comes from `ProcessManager`, not the endpoint.

- [ ] **Step 6: Write failing read-tool mapping tests**

Tests must lock these normalized mappings:

```text
list_components -> world.list_components -> { components }
list_resources  -> world.list_resources  -> { resources }
get_type_schema -> registry.schema       -> { schema }
get_resource    -> world.get_resources   -> { resource, value }
```

`get_entity` without an explicit component list must:

1. call `world.list_components` with `{ entity }`;
2. call `world.get_components` with those component names and `strict: false`;
3. preserve both the BRP `components` and `errors` maps in `EntitySnapshot`.

For `query_entities`, lock standard Bevy request shape:

```ts
expect(call).toEqual({
  method: 'world.query',
  params: {
    data: {
      components: ['fixture::Position'],
      option: [],
      has: ['fixture::Selected']
    },
    filter: {
      with: ['fixture::Position'],
      without: []
    },
    strict: false
  }
});
```

If BRP returns 250 rows and `limit=200`, return 200 rows with `returned: 200, truncated: true`. Never send `limit` or `bevy_mcp_limit` to BRP.

- [ ] **Step 7: Implement read tools**

Register:

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

`get_world_stats` initially checks for `bevy_mcp/world_stats` and returns `unsupported_capability` when absent; Task 3 adds the method.

- [ ] **Step 8: Write failing mutation/raw-method tests**

Lock exact mappings:

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

Void BRP success normalizes to `{ ok: true }`. Spawn normalizes to `{ entity }`.

`call_remote_method` must reject a method name not present in the latest `rpc.discover` result before sending a request.

- [ ] **Step 9: Implement mutation and protocol escape-hatch tools**

Register:

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

Keep mutation schemas generic JSON/reflection inputs; do not add semantic validation.

- [ ] **Step 10: Verify and commit Task 2**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/runtime src/tools src/server.ts
 git commit -m "feat: add generic BRP world tools"
```

---

### Task 3: Add the full-Bevy bridge plugin and runtime fixture

**Files:**
- Create: `Cargo.toml`
- Create: `crates/bevy-mcp-bridge/Cargo.toml`
- Create: `crates/bevy-mcp-bridge/src/lib.rs`
- Create: `crates/bevy-mcp-bridge/src/methods.rs`
- Create: `crates/bevy-mcp-bridge/tests/plugin.rs`
- Create: `fixtures/full-app/Cargo.toml`
- Create: `fixtures/full-app/src/main.rs`

**Interfaces:**
- Produces `bevy_mcp_bridge::BevyMcpPlugin`.
- Produces remote method `bevy_mcp/world_stats`.
- Produces remote method `bevy_mcp/time_control`.
- Produces one actual full Bevy runtime fixture used by later integration tests.

- [ ] **Step 1: Create the Cargo workspace only now that every member exists**

Root `Cargo.toml`:

```toml
[workspace]
members = [
  "crates/bevy-mcp-bridge",
  "fixtures/full-app",
]
default-members = ["crates/bevy-mcp-bridge"]
resolver = "3"
```

Bridge manifest:

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

Fixture manifest:

```toml
[package]
name = "bevy-mcp-full-fixture"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
bevy = "0.19.1"
bevy-mcp-bridge = { path = "../../crates/bevy-mcp-bridge" }
```

Run:

```bash
cargo metadata --no-deps --format-version=1 > /dev/null
```

Expected: PASS; no nonexistent workspace member exists.

- [ ] **Step 2: Write failing Rust tests for custom remote methods**

Tests in `crates/bevy-mcp-bridge/tests/plugin.rs` must prove:

- adding `BevyMcpPlugin` makes `rpc.discover` include `bevy_mcp/world_stats` and `bevy_mcp/time_control`;
- `world_stats` reports entity/archetype/component counts for a tiny test world;
- `time_control` pauses, resumes, and sets relative speed;
- no test asserts screenshot/input/diagnostics booleans from hardcoded bridge state.

Use normal Bevy app updates rather than launching HTTP in unit tests.

Run:

```bash
cargo test -p bevy-mcp-bridge
```

Expected: FAIL before implementation.

- [ ] **Step 3: Implement `BevyMcpPlugin` by composing `BrpExtrasPlugin`**

`src/lib.rs`:

```rust
use bevy::prelude::*;
use bevy::remote::{RemoteMethodSystemId, RemoteMethods};
use bevy_brp_extras::BrpExtrasPlugin;

mod methods;

pub struct BevyMcpPlugin;

impl Plugin for BevyMcpPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(BrpExtrasPlugin);

        let world_stats = app.world_mut().register_system(methods::world_stats);
        let time_control = app.world_mut().register_system(methods::time_control);

        let mut remote = app.world_mut().resource_mut::<RemoteMethods>();
        remote.insert(
            "bevy_mcp/world_stats",
            RemoteMethodSystemId::Instant(world_stats),
        );
        remote.insert(
            "bevy_mcp/time_control",
            RemoteMethodSystemId::Instant(time_control),
        );
    }
}
```

If the exact 0.19.1 `RemoteMethods::insert` signature requires the method name as `String`, adapt the call mechanically; do not introduce another registration abstraction.

`BrpExtrasPlugin` remains the sole HTTP/extras composition layer and honors `BRP_EXTRAS_PORT`.

- [ ] **Step 4: Implement `world_stats`**

Return JSON equivalent to:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorldStats {
    entities: usize,
    archetypes: usize,
    component_counts: BTreeMap<String, usize>,
}
```

Count component instances by adding each archetype's entity count to every component type present in that archetype. Use Bevy component metadata for names. Do not record history/timing.

- [ ] **Step 5: Implement `time_control` against `Time<Virtual>`**

Accepted JSON:

```json
{ "action": "pause" }
{ "action": "resume" }
{ "action": "set_scale", "scale": 2.0 }
```

Reject non-finite/non-positive scales with a BRP invalid-params error. Use only:

```rust
time.pause();
time.unpause();
time.set_relative_speed(scale);
```

Return the current paused state and relative speed after the action.

- [ ] **Step 6: Build the full-app fixture**

`fixtures/full-app/src/main.rs` must contain:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct DebugCounter(u32);

#[derive(Resource, Reflect, Default)]
#[reflect(Resource)]
struct InputState {
    key_a_presses: u32,
}
```

Register both types, insert `InputState`, spawn one `DebugCounter`, a `Camera2d`, and a visible colored sprite/UI primitive. Add a system that increments `InputState.key_a_presses` when `KeyCode::KeyA` is just pressed.

Add:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

This fixture is the only runtime fixture in v1.

- [ ] **Step 7: Verify and commit Task 3**

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

Commit:

```bash
git add Cargo.toml crates fixtures/full-app
 git commit -m "feat: add Bevy MCP bridge plugin"
```

---

### Task 4: Add generic time/input/screenshot/diagnostics control with PNG bounds

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
- Produces `control_time`, `send_keys`, `type_text`, `mouse_input`, `capture_screenshot`, `get_diagnostics`, `shutdown_runtime`.
- Produces `validatePngFile(path: string): Promise<ValidatedPng>` with a hard 16 MiB cap.
- Upgrades managed stop to remote graceful shutdown first.

- [ ] **Step 1: Write failing time/input mapping tests**

Lock:

```text
control_time -> bevy_mcp/time_control
send_keys    -> brp_extras/send_keys
type_text    -> brp_extras/type_text
```

`mouse_input` maps action enum exactly:

```text
move          -> brp_extras/move_mouse
click         -> brp_extras/click_mouse
double_click  -> brp_extras/double_click_mouse
button_down   -> brp_extras/send_mouse_button
drag          -> brp_extras/drag_mouse
scroll        -> brp_extras/scroll_mouse
```

For `button_up`, use the `send_mouse_button` parameter form documented by `bevy_brp_extras` for release; do not synthesize an OS event.

Every handler checks the matching discovered capability/method before calling the runtime.

- [ ] **Step 2: Implement control/input tools**

`control_time` schema:

```ts
const timeControl = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('set_scale'), scale: z.number().finite().positive() })
]);
```

Keep mouse payload schemas close to the underlying extras method parameters; do not create a generic event language.

- [ ] **Step 3: Write failing PNG validation tests**

`src/screenshot/png.spec.ts` must prove rejection of:

- nonexistent file;
- file > 16 MiB, rejected from `stat` before full read;
- wrong PNG signature;
- truncated header;
- zero width;
- zero height.

A valid fixture proves width/height and byte length.

Use constants:

```ts
export const MAX_SCREENSHOT_PNG_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
```

- [ ] **Step 4: Implement bounded PNG validation**

Algorithm:

```ts
const stat = await fs.stat(path);
if (stat.size <= 0 || stat.size > MAX_SCREENSHOT_PNG_BYTES) throw screenshotError(...);

const handle = await fs.open(path, 'r');
const header = Buffer.alloc(24);
await handle.read(header, 0, header.length, 0);
await handle.close();

// bytes 0..7 signature
// bytes 12..15 must be ASCII "IHDR"
// bytes 16..19 width big-endian
// bytes 20..23 height big-endian
```

Only after those checks call `fs.readFile(path)`. Return:

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
2. call `brp_extras/screenshot` with `{ path, camera?, entity?, padding? }` using the exact extras field names;
3. call `validatePngFile`;
4. return MCP image content `mimeType: 'image/png'` with base64 data;
5. delete the temp file in `finally` on success and failure.

Test an oversized file path and prove no image content is returned.

- [ ] **Step 6: Implement screenshot/diagnostics/shutdown tools**

Register:

```text
capture_screenshot
get_diagnostics
shutdown_runtime
```

Mappings:

```text
capture_screenshot -> brp_extras/screenshot
get_diagnostics    -> brp_extras/get_diagnostics
shutdown_runtime   -> brp_extras/shutdown
```

`shutdown_runtime` returns `{ ok: true }` after remote success.

- [ ] **Step 7: Upgrade `stop_bevy` to graceful shutdown first**

When the managed runtime is reachable and advertises `brp_extras/shutdown`:

1. invoke it;
2. wait up to 2 seconds for child exit;
3. if still alive, use the existing child termination path.

Tests use fake timers/process handles and prove fallback occurs exactly once.

- [ ] **Step 8: Verify and commit Task 4**

Run:

```bash
npm run typecheck
npm test
npm run build
cargo test --workspace
```

Expected: PASS.

Commit:

```bash
git add src
 git commit -m "feat: add Bevy runtime control and screenshots"
```

---

### Task 5: Add bridge setup/status and one real full-app MCP integration journey

**Files:**
- Create: `src/tools/bridge.ts`
- Create: `src/tools/bridge.spec.ts`
- Create: `scripts/integration.mjs`
- Modify: `src/server.ts`
- Modify: `fixtures/full-app/src/main.rs` only if the integration test exposes a fixture-observability gap

**Interfaces:**
- Produces `get_bridge_status` and `get_bridge_setup`.
- Produces one MCP-client-driven native integration journey using `@modelcontextprotocol/client`.

- [ ] **Step 1: Write failing bridge status/setup tests**

`get_bridge_status` must combine Cargo metadata plus live method discovery and return:

```ts
export interface BridgeStatus {
  dependencyPresent: boolean;
  runtimeReachable: boolean;
  worldStatsAvailable: boolean;
  timeControlAvailable: boolean;
}
```

`get_bridge_setup` must return exactly the Git-based v1 setup:

```text
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

and:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

There is no mutation/install action.

- [ ] **Step 2: Implement bridge tools**

Register:

```text
get_bridge_status
get_bridge_setup
```

Static dependency detection uses `cargo metadata`; runtime detection uses `rpc.discover`. Do not inspect Rust source.

- [ ] **Step 3: Write the integration script using the real MCP v2 client**

`scripts/integration.mjs` imports:

```js
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

Connect to:

```js
new StdioClientTransport({
  command: 'node',
  args: ['build/index.js']
});
```

The script resolves the repository root and chooses a free port before calling MCP tools.

- [ ] **Step 4: Implement the end-to-end journey**

Through `client.callTool`, execute in this order:

1. `list_bevy_targets` and find `bevy-mcp-full-fixture`;
2. `run_bevy` with the free port;
3. poll `get_runtime_status` until `rpc.discover` is reachable or 20 seconds elapse;
4. `list_components` and assert the reflected `DebugCounter` type is present;
5. `query_entities` for `DebugCounter` and capture its entity ID;
6. `mutate_component` to change the counter;
7. `get_entity` and assert the changed reflected value;
8. `control_time` pause, set scale, resume;
9. `send_keys` with `KeyA`;
10. poll `get_resource` until `InputState.key_a_presses >= 1`;
11. `capture_screenshot` and assert returned image content is PNG and non-empty;
12. `get_diagnostics`;
13. `get_world_stats`;
14. `stop_bevy`;
15. `get_debug_output` and assert fixture startup output is present.

Use bounded polling helpers; no arbitrary sleeps longer than 100 ms between polls.

- [ ] **Step 5: Run the real integration test under Xvfb**

Linux command:

```bash
npm run build
xvfb-run -a npm run test:integration
```

Expected: PASS.

If the fixture cannot initialize graphics in the default GitHub runner, install the minimal Linux packages required by Bevy in Task 6 CI; do not replace the real screenshot path with a fake renderer.

- [ ] **Step 6: Verify and commit Task 5**

Run:

```bash
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
xvfb-run -a npm run test:integration
```

Expected: PASS.

Commit:

```bash
git add src/tools/bridge.ts src/tools/bridge.spec.ts src/server.ts scripts/integration.mjs fixtures/full-app
 git commit -m "test: cover generic Bevy MCP runtime journey"
```

---

### Task 6: Package the agent plugin, add npm release automation, docs, and final verification

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
- Modify: `package.json` only if packed-file coverage requires an explicit file entry

**Interfaces:**
- Publishes one npm binary: `@cwchanap/bevy-plugin`.
- All Agent Plugins/Codex/Claude metadata invokes that same stdio binary.
- CI validates every gate and publishes npm only on release/manual publish trigger.

- [ ] **Step 1: Write plugin metadata matching the existing Godot distribution shape**

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

Root `plugin.json` uses Agent Plugins 1.0.0 schema, name `bevy-plugin`, version `0.1.0`, repository `https://github.com/cwchanap/bevy-mcp`, and MIT license.

`plugins/bevy-plugin/.mcp.json` repeats the same single-server configuration for native marketplace wrappers. Codex/Claude plugin metadata contains no second MCP implementation.

- [ ] **Step 2: Add metadata unit coverage**

Add a small metadata test under the existing test runner (for example `src/tools/bridge.spec.ts` or a focused `src/packaging/metadata.spec.ts`) that reads all metadata JSON and asserts:

- every MCP entry names `bevy`;
- every command is `npx`;
- every args list pins exactly `-y @cwchanap/bevy-plugin@0.1.0`;
- plugin versions are `0.1.0`.

Do not test JSON formatting or key order.

- [ ] **Step 3: Implement a real packed MCP smoke with the v2 client package**

`scripts/smoke-packed-cli.mjs` must:

1. run `npm pack --json`;
2. resolve the produced tarball;
3. install the tarball into a temp directory with npm;
4. start its `bevy-plugin` executable through `StdioClientTransport`;
5. `await client.connect(transport)` to perform initialize;
6. call `client.listTools()`;
7. assert at least:

```text
list_bevy_targets
run_bevy
query_entities
capture_screenshot
get_runtime_status
```

8. close the client;
9. delete the temp directory and packed tarball in `finally`.

Do not hand-write MCP initialize JSON.

Run:

```bash
npm run build
npm run smoke:packed
```

Expected: PASS.

- [ ] **Step 4: Write the README around the actual v1 boundary**

README sections must include:

- what the generic MCP does;
- Node/Rust/Bevy 0.19 requirements;
- npm/MCP usage;
- Codex/Claude/Agent Plugins install examples;
- Bevy app setup via Git dependency:

```bash
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

- how to expose game-owned types with `Reflect` + `register_type`;
- that BRP-only/`bevy_brp_extras` apps already get the standard subset without the companion bridge;
- why `step_frame` is absent;
- localhost/native-only limitations;
- query response caps;
- 16 MiB screenshot cap;
- standalone ECS explicitly deferred, with the future direction: caller-polled bridge dispatching to `bevy_remote::builtin_methods`, not a second protocol.

Do not add Scorpius/Caelum-specific instructions.

- [ ] **Step 5: Add CI plus npm publish behavior**

`.github/workflows/ci.yml` triggers on pushes/PRs to `main`, release publication, and manual workflow dispatch with `trigger_publish`.

Install Linux runtime dependencies before Rust/integration gates:

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

Publish job mirrors `godot-mcp`:

```yaml
if: ${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.event.inputs.trigger_publish == 'true') }}
```

Then:

```bash
npm ci
npm run build
npm publish
```

with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` and npm registry configured by `actions/setup-node`.

There is no crates.io publish job in v1; README/setup uses the Git dependency.

- [ ] **Step 6: Run the complete verification gate locally**

Run:

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

Expected: every command PASS.

- [ ] **Step 7: Self-review the final implementation against the spec**

Verify exact scope:

```bash
git diff --name-only origin/main...HEAD
rg "EcsBridge|bevy_mcp_limit|standalone_ecs|install_bridge_dependency" src crates fixtures scripts package.json Cargo.toml
```

Expected for the `rg` command: no production implementation of those deferred/removed concepts. Documentation may mention `EcsBridge` or standalone ECS only as future direction.

Also verify no game-specific names:

```bash
rg -i "scorpius|caelum|battle_snapshot|transport_demand" src crates fixtures scripts
```

Expected: no matches.

- [ ] **Step 8: Commit Task 6 and keep working on PR #1**

Commit:

```bash
git add README.md plugin.json mcp.json plugins .agents .claude-plugin scripts/smoke-packed-cli.mjs .github package.json src
 git commit -m "docs: package generic Bevy agent plugin"
```

Push the existing `agent/generic-bevy-mcp-design` branch. Update draft PR #1 with implementation results and verification evidence. **Do not open another pull request.**

---

## Deferred standalone ECS rule

There is intentionally no implementation task for standalone `bevy_ecs::World` in v1.

When a real host exists, write a new design slice that keeps the same npm MCP/tool surface and extends `bevy-mcp-bridge` with a caller-polled transport. That slice must use the public Bevy 0.19-style `bevy_remote::builtin_methods` handlers against the host's `World`/`AppTypeRegistry` rather than hand-writing BRP query/get/mutate/schema behavior.

This is a future task, not a hidden partial implementation in Tasks 1-6.
