# Generic Bevy MCP Design

## Status

Revised after design review on September 4, 2026.

V1 is a **generic full-Bevy developer MCP**. It deliberately contains no Scorpius-, Caelum-, or other game-specific operations, and it does not ship a second transport for standalone `bevy_ecs::World` yet.

## Review resolutions

The September 4 review is incorporated as follows:

1. **No private BRP implementation.** Bevy 0.19 exposes public `bevy_remote::builtin_methods` handlers that take `&mut World`. If standalone ECS support is added later, it will dispatch to those handlers instead of reimplementing query/get/mutate/schema logic.
2. **Standalone ECS is deferred from v1.** There is no current standalone `bevy_ecs` consumer. Capability-based design remains, but the second HTTP bridge and ECS-only fixture are removed until a real host exists.
3. **No automatic bridge installation.** V1 exposes setup/status instructions using a Git dependency. The npm release workflow is included so plugin metadata that points at `@cwchanap/bevy-plugin@0.1.0` has an actual publication path.
4. **Capabilities come from `rpc.discover`.** Render/input/diagnostics/shutdown/time are never hardcoded merely because a plugin is present.
5. **Screenshots are bounded.** PNG signature, IHDR dimensions, and a 16 MiB file cap are validated before base64 reaches the agent.
6. **Task order is executable.** Cargo workspace members are created in the same task as their files, packed smoke uses the MCP v2 client package, and all work continues on PR #1.
7. **Read results are typed.** The MCP pins stable result shapes for list/entity/resource/query/schema tools instead of leaking unspecified BRP responses.

## Context

The product goal is analogous to `cwchanap/godot-mcp`: one agent-neutral stdio MCP package, usable from Codex, Claude Code, Pi, Cursor, or another MCP-compatible client, that can launch and debug a local engine runtime.

Bevy 0.19 already provides most runtime capabilities needed:

- **Bevy Remote Protocol (BRP)**: reflected ECS inspection/mutation, registry schema, method discovery, and generic remote control over JSON-RPC.
- **`bevy_brp_extras` 0.22.3**: screenshot capture, graceful shutdown, keyboard input, text input, mouse control, and FPS/frame-time diagnostics.

V1 should compose those mechanisms rather than duplicate them.

## Product goal

An agent should be able to:

- discover Bevy executable targets from Cargo metadata;
- build/run/stop/restart one managed target;
- read bounded stdout/stderr;
- discover the live remote-method/capability surface;
- list/query/read reflected ECS components and resources;
- mutate reflected ECS state using standard BRP operations;
- inspect cheap world statistics;
- pause/resume/change Bevy virtual-time scale;
- send keyboard/text/mouse input;
- capture validated screenshots;
- query Bevy diagnostics;
- gracefully shut down the runtime;
- call newly discovered BRP methods through one generic raw escape hatch;
- install the MCP through one npm binary and thin agent-plugin metadata wrappers.

## Non-goals

V1 does **not** include:

- game-specific or semantic debug operations;
- standalone `bevy_ecs::World` transport;
- save-state manipulation;
- gameplay assertion/test DSLs;
- deterministic replay or `step_frame`;
- frame/render debugger or schedule profiler;
- WASM/browser relay;
- remote-machine debugging;
- OS-level input automation;
- scene/asset authoring;
- automatic Rust source rewriting;
- Bevy-version compatibility shims;
- a cross-engine abstraction shared with Godot.

## Compatibility baseline

- Bevy: `0.19.x`
- `bevy_brp_extras`: `0.22.3`
- Rust: `>=1.95.0`, edition 2024 for repository-owned Rust code
- Node.js: `>=20`
- MCP TypeScript SDK: stable v2 packages for the 2026-07-28 MCP specification
- Zod: v4
- Agent Plugins: `1.0.0`
- native macOS/Linux/Windows runtime debugging only

A later Bevy release gets an explicit version update, not a v1 compatibility layer.

## Architecture

```text
Codex / Claude Code / Pi / Cursor / MCP clients
                         |
                         | MCP stdio
                         v
              @cwchanap/bevy-plugin
              Node / TypeScript server
                         |
                 localhost BRP
                         |
                         v
                  Bevy application
              BRP + BrpExtrasPlugin
                  + BevyMcpPlugin
```

Responsibilities:

- **Node MCP**: Cargo discovery, process/log ownership, capability probing, MCP schemas, BRP translation, screenshot file validation, plugin packaging.
- **BRP**: generic ECS operations and schema/method discovery.
- **`bevy_brp_extras`**: screenshot/input/diagnostics/shutdown.
- **`BevyMcpPlugin`**: only the generic operations not supplied above: world statistics and virtual-time control.

The MCP owns the agent-facing contract but not a replacement engine protocol.

## Companion Rust plugin

Repository crate:

```text
crates/bevy-mcp-bridge
```

Public integration:

```rust
App::new()
    .add_plugins(DefaultPlugins)
    .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
    .run();
```

`BevyMcpPlugin`:

1. composes `bevy_brp_extras::BrpExtrasPlugin`;
2. registers `bevy_mcp/world_stats` in the live `RemoteMethods` resource;
3. registers `bevy_mcp/time_control` in the live `RemoteMethods` resource.

It has no separate HTTP server. `BrpExtrasPlugin`/Bevy HTTP remains authoritative and defaults to loopback `127.0.0.1:15702`; `BRP_EXTRAS_PORT` is the only port environment variable v1 needs.

Projects already using standard BRP/`bevy_brp_extras` can use the standard subset of MCP tools without `BevyMcpPlugin`. The bridge only adds time control/world stats and provides one recommended setup path.

## Reflection boundary

Generic ECS tools operate only on Bevy-reflectable registered types.

Example:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct Health {
    current: i32,
    max: i32,
}

app.register_type::<Health>();
```

Installing the bridge does not make opaque game-owned values inspectable automatically. The README must state this prominently.

No unsafe memory inspection or parallel serde/debug registry is added.

## Capability model

`get_runtime_status` calls `rpc.discover` and derives capability flags from exact method names.

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
```

Rules:

- `process`: true only for the MCP-owned child;
- `app`: true for a reachable BRP application endpoint;
- `ecsRead`: required BRP read methods discovered;
- `ecsWrite`: required BRP mutation methods discovered;
- `registrySchema`: `registry.schema` discovered;
- `render`: `brp_extras/screenshot` discovered;
- `input`: the required extras keyboard/mouse methods discovered;
- `virtualTime`: `bevy_mcp/time_control` discovered;
- `diagnostics`: `brp_extras/get_diagnostics` discovered;
- `gracefulShutdown`: `brp_extras/shutdown` discovered.

Capabilities mean an operation is remotely advertised. A specific call can still fail for runtime preconditions, such as screenshot with no eligible window/camera.

Missing methods return `unsupported_capability`; the MCP does not emulate them.

## Cargo discovery and process lifecycle

Use only:

```text
cargo metadata --no-deps --format-version=1
```

for workspace/target discovery.

```ts
export interface BevyTarget {
  packageName: string;
  manifestPath: string;
  targetName: string;
  kind: 'bin' | 'example';
  runtimeKind: 'full_bevy' | 'unknown';
}
```

`runtimeKind` is informational only. Runtime authorization comes from live discovery.

Process tools:

```text
list_bevy_targets
build_bevy
run_bevy
stop_bevy
restart_bevy
get_debug_output
```

Rules:

- Cargo is always invoked with argv, never shell strings.
- One managed child per MCP server process.
- `run_bevy` sets `BRP_EXTRAS_PORT` for the selected runtime port.
- stdout/stderr keep a 5000-line ring buffer plus a temp log file.
- `get_debug_output` defaults to 200 lines and caps at 5000.
- `stop_bevy` tries advertised `brp_extras/shutdown`, waits at most 2 seconds, then terminates the managed child if necessary.
- `restart_bevy` reuses the previous launch spec.

External BRP apps may be inspected by port, but historical logs are unavailable if the MCP did not launch them.

## Runtime client

One client:

```ts
class RuntimeClient {
  constructor(port = 15702, timeoutMs = 5000) {}
  call<T>(method: string, params?: unknown): Promise<T>;
}
```

It uses built-in `fetch` against `http://127.0.0.1:<port>/`, applies a five-second timeout, parses JSON-RPC success/error explicitly, and maps failures into the MCP error model.

No retries, auth, TLS, daemon, or connection pool.

## Stable read contracts

```ts
export interface ListComponentsResult {
  components: string[];
}

export interface ListResourcesResult {
  resources: string[];
}

export interface TypeSchemaResult {
  schema: Record<string, unknown>;
}

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

`get_entity` preserves Bevy's non-strict `components` and `errors` distinction instead of flattening it away.

`get_type_schema` wraps standard `registry.schema` output under `schema`; there is no second schema exporter.

## ECS tool surface

Read:

```text
list_components
list_resources
get_type_schema
query_entities
get_entity
get_resource
get_world_stats
```

Mutation:

```text
spawn_entity
remove_entity
set_components
mutate_component
remove_components
set_resource
mutate_resource
remove_resource
```

Mappings use standard BRP names such as `world.query`, `world.get_components`, `world.get_resources`, `world.insert_components`, and `world.mutate_resources`.

`query_entities` forwards the normal BRP query model:

```ts
export interface QueryEntitiesInput {
  port?: number;
  components?: string[];
  optional?: string[];
  has?: string[];
  with?: string[];
  without?: string[];
  strict?: boolean;
  limit?: number;
}
```

`limit` is only an MCP response cap: default 200, maximum 2000. It is never sent to BRP and there is no `bevy_mcp_limit` dialect.

## App control

```text
control_time
send_keys
type_text
mouse_input
capture_screenshot
shutdown_runtime
```

`control_time`:

```ts
type TimeControl =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'set_scale'; scale: number };
```

`scale` must be finite and greater than zero.

No `step_frame`: virtual-time pause is not a generic whole-app frame stepper.

### Mouse operations

V1 exposes only operations actually provided by `bevy_brp_extras`:

```text
move
click
double_click
press
drag
scroll
```

Mappings:

```text
move         -> brp_extras/move_mouse
click        -> brp_extras/click_mouse
double_click -> brp_extras/double_click_mouse
press        -> brp_extras/send_mouse_button   # timed press-hold-release
drag         -> brp_extras/drag_mouse
scroll       -> brp_extras/scroll_mouse
```

There are no persistent `button_down`/`button_up` actions because `bevy_brp_extras` does not provide those semantics.

No OS accessibility APIs are used.

## Screenshots

`capture_screenshot` calls `brp_extras/screenshot` with a temp `.png` path and optional camera/entity/padding parameters.

Before returning image content:

1. `stat` the file;
2. reject empty or >16 MiB files before full read;
3. validate the eight-byte PNG signature;
4. validate a complete IHDR header;
5. require positive width and height;
6. read/encode the validated file;
7. delete the temp file in `finally`.

Malformed/oversized screenshots fail rather than entering agent context.

## Diagnostics and raw method escape hatch

```text
get_diagnostics
list_remote_methods
call_remote_method
```

- `get_diagnostics` -> `brp_extras/get_diagnostics`
- `list_remote_methods` -> `rpc.discover`
- `call_remote_method` accepts only a method present in the latest discovery response and forwards raw JSON params/result.

The escape hatch allows new BRP methods to be tried without creating project-specific MCP tools.

## World statistics

`bevy_mcp/world_stats` returns cheap aggregate state only:

```ts
export interface WorldStats {
  entities: number;
  archetypes: number;
  componentCounts: Record<string, number>;
}
```

Component counts are derived from current archetypes. No timing/history/profiling store.

## Virtual time

`bevy_mcp/time_control` operates on `Time<Virtual>`:

- `pause()`
- `unpause()`
- `set_relative_speed(scale)`

It returns the resulting paused/relative-speed state.

## Bridge setup/status

V1 exposes:

```text
get_bridge_status
get_bridge_setup
```

`get_bridge_status` combines Cargo metadata and live `rpc.discover` to report dependency presence and availability of `bevy_mcp/world_stats`/`bevy_mcp/time_control`.

`get_bridge_setup` returns copyable instructions only:

```bash
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

There is no `install_bridge_dependency` and no Rust-source rewrite.

The Rust crate uses the Git dependency in v1; crates.io publication is not required.

## npm and agent-plugin distribution

Server package:

```text
@cwchanap/bevy-plugin
```

Metadata layout:

```text
plugin.json
mcp.json
plugins/bevy-plugin/.mcp.json
plugins/bevy-plugin/.codex-plugin/plugin.json
plugins/bevy-plugin/.claude-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

Every wrapper starts the same stdio package. There is no client-specific MCP implementation.

The GitHub Actions workflow publishes npm on GitHub Release publication or explicit manual publish trigger using `NPM_TOKEN`, mirroring the existing Godot plugin release shape.

Agent metadata may pin `@cwchanap/bevy-plugin@0.1.0`; it becomes usable once that npm release is published.

## Packed MCP smoke

Dev dependency:

```text
@modelcontextprotocol/client
```

The smoke must:

1. `npm pack`;
2. install the tarball in a temp directory;
3. start its binary with `StdioClientTransport`;
4. connect using `Client.connect()` (real initialize handshake);
5. list tools;
6. assert core generic tools;
7. close/delete temporary artifacts.

No hand-written MCP initialize packets.

## Integration fixture

V1 has one runtime fixture:

```text
fixtures/full-app
```

It is a real Bevy application with:

- one reflected component;
- one reflected resource changed by injected keyboard input;
- one camera and visible primitive for screenshot proof;
- `BevyMcpPlugin`.

One MCP-client-driven Xvfb journey proves:

1. target discovery + launch;
2. `rpc.discover`/capabilities;
3. ECS read + mutation;
4. virtual-time control;
5. input changes reflected state;
6. screenshot validation;
7. diagnostics/world stats;
8. graceful stop + logs.

No ECS-only fixture in v1.

## Future standalone ECS extension

When a real standalone `bevy_ecs::World` host exists, extend the same Rust crate and MCP contract.

Expected shape:

```text
HTTP thread -> request channel -> EcsBridge::poll(&mut World) -> response channel
```

Required constraints:

- caller retains `World` and schedule ownership;
- use the world's `AppTypeRegistry`;
- dispatch standard methods through public `bevy_remote::builtin_methods` handlers;
- preserve standard BRP method names, entity encoding, schema, and errors;
- no private reflection serializer/protocol implementation;
- no standalone-only query-limit field;
- render/input/time/diagnostics remain unsupported unless actually supplied by that host.

This is a future slice only when a real consumer can validate it.

## Error model

```text
invalid_request
project_not_found
target_not_found
process_already_running
process_not_running
runtime_unreachable
unsupported_capability
remote_error
io_error
```

Preserve BRP code/message in `remote_error` details where useful; do not mirror every BRP error as a new MCP error class.

## Security boundary

Local development only:

- connect/bind through Bevy's loopback defaults;
- Cargo argv only, no arbitrary shell tool;
- runtime targets must come from Cargo metadata;
- no auth/TLS/retry framework;
- screenshot payload validation before agent return.

## Testing strategy

Three layers only:

1. **TypeScript unit tests**: Cargo/process, JSON-RPC, capability derivation, normalized tools, screenshot validation, metadata.
2. **Rust tests**: bridge plugin registration, world stats, virtual-time control.
3. **One full-app integration fixture**: real process + BRP + reflection + input + screenshot + diagnostics + shutdown under Xvfb.

Do not duplicate BRP's own behavior tests.

## Delivery boundary

This task remains **PR #1**. Planning and implementation stay on `agent/generic-bevy-mcp-design`; no second PR is opened.

V1 is complete when:

- npm package builds and packed-client smoke passes;
- Cargo discovery/build/run/log tools work;
- generic reflected ECS read/write tools use standard BRP;
- stable read result shapes are tested;
- capabilities derive from `rpc.discover`;
- bridge adds only world stats/time control on top of BRP extras;
- input/screenshot/diagnostics/shutdown reuse `bevy_brp_extras`;
- screenshot size/signature/dimensions are validated;
- bridge setup/status returns Git instructions without editing user source;
- one real full-app integration journey passes;
- agent plugin metadata invokes one npm binary;
- npm release automation exists;
- README documents reflection requirements and the future standalone seam;
- no game-specific or standalone-ECS implementation ships in v1.
