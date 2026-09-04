# Generic Bevy MCP Design

## Status

Revised after design review on September 4, 2026.

This document defines a generic Bevy developer MCP. V1 deliberately contains no Scorpius-, Caelum-, or other game-specific operations.

## Context

The goal is a reusable local developer tool analogous in product shape to `cwchanap/godot-mcp`: install one MCP/plugin package into Codex, Claude Code, Pi, Cursor, or another MCP-compatible agent, point it at a Rust workspace, and let the agent run and debug a Bevy application through a stable generic tool surface.

The first concrete consumer is a normal Bevy 0.19 application. Bevy already provides most of the runtime protocol we need:

- Bevy Remote Protocol (BRP) exposes reflected ECS inspection/mutation, registry schema, method discovery, and related generic operations over JSON-RPC.
- `bevy_brp_extras` 0.22.3 adds screenshot capture, shutdown, keyboard/mouse control, and FPS/frame-time diagnostics for Bevy 0.19 apps.

V1 should compose those existing capabilities instead of implementing a second remote protocol.

A future standalone `bevy_ecs::World` host remains an expected extension case, but no current project uses that shape yet. Caelum plans to introduce standalone `bevy_ecs` later; building a second HTTP/BRP stack before that host exists is unnecessary v1 scope.

## Product goal

Build one generic MCP server and small companion Bevy plugin that let an agent:

- discover executable Bevy targets in a Cargo workspace;
- build/run/stop/restart one managed target;
- capture bounded stdout/stderr debug output;
- discover the live remote method/capability surface;
- inspect reflected ECS components/resources and registry schemas;
- query entities and read individual entity/resource state;
- perform generic reflected ECS mutations;
- inspect broad world/runtime diagnostics;
- pause/resume/change Bevy virtual-time scale;
- send keyboard and mouse input;
- capture validated screenshots;
- gracefully shut down the runtime;
- call newly discovered remote methods through one raw escape hatch;
- install through the same npm MCP binary from Agent Plugins/Codex/Claude wrappers.

## Non-goals

V1 does **not** include:

- project/game-specific MCP tools or semantic operations;
- standalone `bevy_ecs::World` transport;
- application-authored debug command frameworks;
- save manipulation, gameplay assertions, or test DSLs;
- deterministic replay or `step_frame`;
- frame/render debugger or schedule profiler;
- browser/WASM runtime transport;
- remote-machine/network debugging;
- OS-level keyboard/mouse automation;
- arbitrary Bevy asset/scene authoring;
- automatic Rust source rewriting;
- Bevy-version compatibility shims;
- backward compatibility with pre-release layouts;
- a generic engine abstraction shared with Godot.

## Compatibility baseline

V1 targets one stack only:

- Bevy: `0.19.x`;
- `bevy_brp_extras`: `0.22.3`;
- Rust: `>=1.95.0`, edition 2024 for repository-owned Rust code;
- Node.js: `>=20`;
- MCP TypeScript SDK: stable v2 packages implementing the 2026-07-28 MCP specification;
- Zod: v4;
- Agent Plugins specification: `1.0.0`;
- native macOS/Linux/Windows runtime debugging only.

A future Bevy release gets an explicit version update instead of a compatibility layer.

## Architecture decision

Use one Node/TypeScript stdio MCP server in front of the official Bevy remote stack.

```text
Codex / Claude Code / Pi / Cursor / other MCP clients
                         |
                         | MCP stdio
                         v
              @cwchanap/bevy-plugin
              Node / TypeScript server
                         |
             localhost JSON-RPC / BRP
                         |
                         v
                  Bevy application
             Bevy Remote Protocol
              + bevy_brp_extras
              + BevyMcpPlugin
```

The MCP owns the agent-facing tool contract. Bevy owns generic ECS protocol behavior. `bevy_brp_extras` owns screenshot/input/diagnostics/shutdown behavior. `BevyMcpPlugin` only supplies the small generic features missing from those layers.

### Why not wrap `bevy_brp_mcp` directly?

`bevy_brp_mcp` is a useful reference implementation, but this project wants its own stable tool names, process-management behavior, plugin packaging, and future extension seam. Reusing BRP does not require inheriting another MCP server's public contract.

### Why not implement a private BRP subset?

Bevy 0.19 publicly exposes its built-in BRP handlers as systems taking `&mut World`, including query/get/list/spawn/despawn/insert/remove/mutate and registry schema handlers. If standalone ECS support is added later, the bridge should dispatch to those built-ins at a caller-controlled `World` polling boundary rather than duplicate their serialization/error semantics.

There is no `reflect.rs` protocol reimplementation in v1 or in the intended future standalone design.

## Companion Rust plugin

The repository owns one crate:

```text
crates/bevy-mcp-bridge
```

The crate exposes:

```rust
pub struct BevyMcpPlugin;
```

Typical integration:

```rust
App::new()
    .add_plugins(DefaultPlugins)
    .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
    .run();
```

`BevyMcpPlugin`:

1. composes `bevy_brp_extras::BrpExtrasPlugin`;
2. registers `bevy_mcp/world_stats`;
3. registers `bevy_mcp/time_control`;
4. honors the same loopback port used by the MCP-managed process.

It does **not** wrap or replace BRP world methods.

Projects that already expose standard BRP/`bevy_brp_extras` can use most MCP tools without this crate. The companion plugin only adds the repository-owned time/world-stat methods and gives one recommended setup path.

## Reflection boundary

Generic ECS tools only operate on types Bevy can reflect and that the app registers in its type registry.

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

The MCP does not inspect arbitrary Rust memory and does not invent a second serde registration framework.

The README must explicitly explain that installing the plugin alone does not make opaque game-owned resources/components remotely inspectable; those types need normal Bevy reflection registration.

## Runtime capability model

`get_runtime_status` probes `rpc.discover` and derives capabilities from the methods the runtime actually advertises. Do not hardcode `render`, `input`, `diagnostics`, or shutdown support merely because `BevyMcpPlugin` is present.

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

Derivation:

- `process`: true only when this MCP owns the running child;
- `ecsRead`: required BRP read methods are discovered;
- `ecsWrite`: required BRP mutation methods are discovered;
- `registrySchema`: `registry.schema` is discovered;
- `app`: a reachable BRP endpoint represents a Bevy app;
- `render`: `brp_extras/screenshot` is discovered;
- `input`: required keyboard/mouse methods are discovered;
- `virtualTime`: `bevy_mcp/time_control` is discovered;
- `diagnostics`: `brp_extras/get_diagnostics` is discovered;
- `gracefulShutdown`: `brp_extras/shutdown` is discovered.

These flags describe remotely advertised operations. Individual calls can still return normal runtime errors when their current app preconditions are absent (for example, screenshot with no eligible window/camera).

A tool requiring a missing capability returns `unsupported_capability`; it does not emulate the feature.

## Cargo target discovery

Use:

```text
cargo metadata --no-deps --format-version=1
```

as the only workspace/target authority.

```ts
export interface BevyTarget {
  packageName: string;
  manifestPath: string;
  targetName: string;
  kind: 'bin' | 'example';
  runtimeKind: 'full_bevy' | 'unknown';
}
```

`runtimeKind` is inferred only from direct dependency names and is informational. Live operations are authorized by `rpc.discover`, not static dependency inference.

No recursive Rust source parser is needed.

## Process lifecycle

The MCP manages at most one child process per server process in v1.

`run_bevy`:

- resolves an exact target from `list_bevy_targets`;
- uses argv-based `cargo run`, never a shell string;
- forwards optional app args after `--`;
- sets `BEVY_MCP_PORT` and `BRP_EXTRAS_PORT` to the selected port;
- captures stdout/stderr into a bounded 5000-line in-memory tail and a temp log file;
- returns after spawn rather than blocking for game exit.

`stop_bevy`:

1. calls generic graceful shutdown when advertised;
2. waits up to 2 seconds;
3. terminates the managed child if still alive.

`restart_bevy` reuses the last launch specification.

External processes can be inspected by port but cannot expose historical stdout/stderr through this MCP.

## Runtime client

Use one small `RuntimeClient` around built-in `fetch`:

```ts
class RuntimeClient {
  constructor(port = 15702, timeoutMs = 5000) {}
  call<T>(method: string, params?: unknown): Promise<T>;
}
```

Rules:

- connect only to `http://127.0.0.1:<port>/`;
- 5-second request timeout;
- parse JSON-RPC success/error explicitly;
- map transport failures into stable MCP-facing errors;
- no retries, auth, TLS, daemon, or connection pool in v1.

## Agent-facing read contracts

Do not leak unspecified "whatever BRP returned" shapes from tool handlers. V1 pins these normalized MCP result types.

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

Bevy's documented non-strict `world.get_components` response includes separate `components` and `errors` maps; normalize both into `EntitySnapshot` instead of discarding the distinction.

`registry.schema` remains authoritative; `TypeSchemaResult` only wraps its returned schema under a stable MCP key.

## MCP tool surface

### Project/process

```text
list_bevy_targets
run_bevy
stop_bevy
restart_bevy
get_debug_output
get_runtime_status
```

### ECS discovery/read

```text
list_components
list_resources
get_type_schema
query_entities
get_entity
get_resource
get_world_stats
```

`query_entities` accepts:

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

The MCP forwards the standard BRP query shape. `limit` is an **agent-response cap**, not a nonstandard BRP parameter. It defaults to 200 and may not exceed 2000. The MCP truncates the BRP result before returning it to the agent.

Do not invent `bevy_mcp_limit` or another private query dialect.

### ECS mutation

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

These are thin validated mappings onto standard BRP methods. Mutation tools do not add game-aware validation.

### App control

```text
control_time
send_keys
type_text
mouse_input
capture_screenshot
shutdown_runtime
```

`control_time` accepts exactly:

```ts
type TimeControl =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'set_scale'; scale: number };
```

`scale` must be finite and greater than zero.

V1 deliberately does not expose `step_frame`. Pausing virtual time is not equivalent to stopping every system scheduled each frame.

`mouse_input` accepts:

```text
move
click
double_click
button_down
button_up
drag
scroll
```

and maps onto `bevy_brp_extras` methods. No OS accessibility automation is used.

### Diagnostics/protocol escape hatch

```text
get_diagnostics
list_remote_methods
call_remote_method
```

`list_remote_methods` maps to `rpc.discover`.

`call_remote_method` accepts only a method name present in the latest discovery response plus raw JSON params. It exists so agents can experiment with newly available BRP methods without a new MCP release. It is not a game-specific extension framework.

## Screenshots

`capture_screenshot` is a first-class tool backed by `brp_extras/screenshot`.

Input:

```ts
export interface ScreenshotInput {
  port?: number;
  cameraEntity?: number;
  entity?: number;
  padding?: number;
}
```

The MCP creates a temp `.png` path, asks the runtime to write the screenshot, validates the resulting file, returns MCP image content, and deletes the temp file in `finally`.

Before reading/encoding the whole image:

1. `stat` the file and reject files larger than 16 MiB;
2. read the PNG header;
3. require the eight-byte PNG signature;
4. require a valid IHDR with positive width/height;
5. read at most the validated file size;
6. return `image/png` MCP content.

No oversized or malformed PNG reaches the agent as a base64 payload.

## World statistics

`bevy_mcp/world_stats` is repository-owned because BRP does not provide the exact summary tool wanted by agents.

Return only cheap aggregate information:

```ts
export interface WorldStats {
  entities: number;
  archetypes: number;
  componentCounts: Record<string, number>;
}
```

Do not turn this into a profiler or historical metrics store.

## Virtual time

`bevy_mcp/time_control` operates on Bevy `Time<Virtual>`:

- pause;
- resume;
- set finite relative speed greater than zero.

It does not promise deterministic frame stepping.

## Bridge setup and status

V1 does not automatically edit `Cargo.toml` or Rust source.

Expose:

```text
get_bridge_status
get_bridge_setup
```

`get_bridge_status` reports:

- whether Cargo metadata shows `bevy-mcp-bridge` as a dependency for the selected package;
- whether the running endpoint exposes `bevy_mcp/world_stats` and `bevy_mcp/time_control`.

`get_bridge_setup` returns copyable integration instructions, using the repository Git dependency until the Rust crate is intentionally published:

```bash
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

and:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

There is no `install_bridge_dependency` tool in v1.

## npm/plugin distribution

The MCP server is published as:

```text
@cwchanap/bevy-plugin
```

The repository ships the same metadata shape used by `godot-mcp`:

```text
plugin.json
mcp.json
plugins/bevy-plugin/.mcp.json
plugins/bevy-plugin/.codex-plugin/plugin.json
plugins/bevy-plugin/.claude-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

All wrappers invoke one stdio MCP binary. There is no Codex-specific or Claude-specific server.

The release workflow must publish npm on a GitHub Release or explicit manual publish trigger. Agent metadata may pin `@cwchanap/bevy-plugin@0.1.0`; it becomes usable once that release is published. CI must not claim marketplace installation works before npm publication.

The Rust bridge uses the Git dependency in v1; crates.io publication is not required for the first MCP release.

## Packed MCP smoke

The packed-package smoke uses the MCP v2 client package, not a hand-written initialize packet.

Dev dependency:

```text
@modelcontextprotocol/client
```

The smoke:

1. `npm pack`;
2. starts the packed `bevy-plugin` binary with `StdioClientTransport`;
3. performs the MCP initialize handshake through `Client.connect()`;
4. lists tools;
5. asserts core generic tool names;
6. closes the client/process cleanly.

## Full-App integration fixture

The repository has exactly one runtime fixture in v1:

```text
fixtures/full-app
```

It uses a normal Bevy app, registers a small reflected component/resource, includes `BevyMcpPlugin`, and renders enough UI/world content to exercise screenshot and input under Xvfb on Linux CI.

Integration coverage must prove one end-to-end journey:

1. launch fixture through the MCP process manager;
2. wait for `rpc.discover`;
3. inspect reflected ECS state;
4. mutate one reflected field;
5. pause/resume or change virtual-time scale;
6. inject one input action whose reflected state changes;
7. capture and validate a screenshot;
8. query diagnostics/world stats;
9. gracefully stop the app;
10. assert the process exits and logs are readable.

Do not add an ECS-only fixture in v1.

## Future standalone ECS extension

When a real standalone `bevy_ecs::World` consumer exists, extend the same Rust crate rather than create a second server/package.

Expected shape:

```text
HTTP thread -> request channel -> EcsBridge::poll(&mut World) -> response channel
```

Constraints for that future work:

- caller retains `World`/schedule ownership;
- insert/use the world's `AppTypeRegistry` for debug-visible types;
- dispatch standard verbs to public `bevy_remote::builtin_methods` handlers;
- reuse standard BRP method names, entity encoding, schema, and errors;
- no private `reflect.rs` protocol implementation;
- no standalone-only query-limit parameter;
- renderer/input/virtual-time/BRP-extras capabilities remain unsupported unless the host actually exposes them.

That future slice starts only when a real consumer can validate it.

## Error model

MCP-facing failures use a small stable set:

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

Preserve the remote BRP message/code inside `remote_error` details where useful. Do not create an error hierarchy mirroring every BRP code.

## Security boundary

This is a local development tool.

V1:

- binds/connects only to loopback;
- executes Cargo via argv, not shell strings;
- only runs targets returned by Cargo metadata;
- does not expose arbitrary shell execution;
- uses no auth/TLS/retry framework;
- validates screenshot size/type before returning image content.

No production hardening framework is required.

## Testing strategy

Use three layers only:

1. **TypeScript unit tests** — Cargo parsing, process lifecycle, JSON-RPC mapping, normalized tool contracts, capability derivation, screenshot validation, packaging metadata.
2. **Rust tests** — `BevyMcpPlugin` registration, world stats, virtual-time control.
3. **One native full-app integration fixture** — process + BRP + reflection + mutation + input + screenshot + diagnostics + shutdown.

Do not duplicate every BRP behavior in repository tests; Bevy owns those protocol implementations.

## Delivery boundary

This task remains one PR: PR #1.

The PR begins with these planning docs and, after approval, implementation continues on the same branch/PR. Do not open a second implementation PR.

V1 is complete when:

- the npm MCP package builds and its packed stdio smoke passes;
- Cargo target discovery/process/log tools work;
- generic reflected ECS read/write tools work through standard BRP;
- normalized read result shapes are tested;
- runtime capabilities are derived from `rpc.discover`;
- `BevyMcpPlugin` adds only world stats/time control on top of BRP extras;
- input, screenshot, diagnostics, and shutdown reuse `bevy_brp_extras`;
- screenshot payloads are size/signature/dimension validated;
- bridge setup/status provides Git-dependency instructions without source rewriting;
- the full-app integration journey passes under CI;
- Codex/Claude/Agent Plugins metadata points at the one npm binary;
- release automation can publish `@cwchanap/bevy-plugin` to npm;
- README documents reflection requirements and the future standalone extension seam;
- no game-specific or standalone-ECS implementation ships in v1.
