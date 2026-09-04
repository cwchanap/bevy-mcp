# Generic Bevy MCP Design

## Status

Approved architectural direction from the September 3, 2026 design discussion. This document defines a generic Bevy developer MCP; it deliberately contains no Scorpius-, Caelum-, or other game-specific operations.

## Context

The goal is a reusable local developer tool analogous in product shape to `cwchanap/godot-mcp`: install one MCP/plugin package into Codex, Claude Code, Pi, or another MCP-compatible agent, point it at a Rust workspace, and let the agent run and debug a Bevy runtime through a stable generic tool surface.

The first consumers have two materially different shapes:

1. A normal Bevy application, where Bevy owns an `App`, render world, window/input stack, ECS world, and schedules.
2. A simulation-heavy Rust application that uses standalone `bevy_ecs::World` without adopting the full Bevy app/renderer/UI stack.

The MCP must make the common debugging loop good for both without forcing standalone ECS projects to become full Bevy applications merely for tooling.

Bevy 0.19 already ships the Bevy Remote Protocol (BRP), a JSON-RPC 2.0 protocol with generic reflected ECS operations such as `world.query`, component/resource inspection and mutation, registry schema discovery, event triggering, and method discovery. `bevy_brp_extras` 0.22.3 composes with Bevy 0.19 BRP and adds screenshot, shutdown, keyboard/mouse control, and diagnostics. Those existing mechanisms should remain authoritative for full Bevy applications instead of being reimplemented here.

The missing case is standalone `bevy_ecs`: there is no `App` or native BRP HTTP plugin to attach. This repository therefore owns only the minimal bridge necessary to expose a BRP-shaped reflected ECS subset around a caller-owned `World`.

## Product goal

Build a generic MCP server and companion Rust bridge that let an agent:

- discover, build, run, stop, and restart Rust/Bevy targets;
- capture and read managed-process debug output;
- discover runtime capabilities;
- inspect and mutate reflected ECS components/resources;
- query entities and registry/type information;
- inspect broad world/runtime diagnostics;
- control virtual time in full Bevy apps;
- send keyboard and mouse input to full Bevy apps;
- capture screenshots from full Bevy apps;
- gracefully shut down a full Bevy app;
- use the same MCP tool names against a full Bevy app or a standalone ECS bridge whenever the capability exists;
- install through portable Agent Plugins metadata and client-specific marketplace wrappers without maintaining separate MCP server implementations.

## Non-goals

The first release does **not** include:

- project/game-specific MCP tools or semantic operations;
- application-authored debug commands, save manipulation, gameplay assertions, or test DSLs;
- deterministic replay, frame debugger, render debugger, or schedule profiler;
- browser/WASM runtime transport;
- remote-machine/network debugging;
- OS-level keyboard/mouse automation;
- arbitrary editor/resource authoring comparable to Godot scene authoring;
- automatic reasoning about game semantics such as enemies, citizens, battles, missions, roads, or routes;
- Bevy-version compatibility shims;
- backward compatibility with pre-release bridge/protocol layouts;
- a generic engine abstraction shared with Godot or other engines.

## Compatibility baseline

The first implementation targets one current stack only:

- Bevy / `bevy_ecs`: `0.19.x`;
- `bevy_brp_extras`: `0.22.3` for full Bevy applications;
- Rust edition: 2024 for this repository's bridge crate and fixtures;
- Node.js: `>=20`;
- MCP TypeScript SDK: stable v2 packages implementing the 2026-07-28 MCP specification;
- Agent Plugins specification: `1.0.0`;
- native macOS/Linux/Windows execution only for runtime debugging.

A future Bevy release gets an explicit version update rather than a compatibility layer in v1.

## Architecture decision

Use one Node/TypeScript MCP facade with capability-based runtime adapters.

```text
Codex / Claude Code / Pi / Cursor / other MCP clients
                         |
                         | MCP stdio
                         v
              @cwchanap/bevy-plugin
              Node / TypeScript server
                         |
              stable generic MCP tools
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Full Bevy adapter       Standalone ECS adapter
       HTTP BRP client          HTTP JSON-RPC client
             |                       |
             v                       v
   Bevy Remote Protocol       bevy_mcp_bridge::EcsBridge
   + bevy_brp_extras               |
             |                      | caller polls at a
             v                      | safe world boundary
          Bevy App                  v
       + render/input          bevy_ecs::World
       + ECS/schedules         owned by host application
```

The MCP owns the agent-facing contract. Runtime adapters decide how each generic operation is satisfied.

### Why not wrap `bevy_brp_mcp` directly?

`bevy_brp_mcp` is a useful reference implementation and validates the value of BRP, launch management, logs, screenshots, input, component watching, and diagnostics. However, making it the product boundary would center the architecture on a BRP-enabled full Bevy app and would not solve the standalone `bevy_ecs::World` case cleanly.

The project should reuse Bevy's protocol and `bevy_brp_extras`, not inherit another MCP server's public tool contract.

### Why not reimplement full-app control?

For Bevy 0.19, `bevy_brp_extras` already provides native BRP setup plus:

- full-window/camera/entity screenshots;
- graceful shutdown;
- keyboard input and sequential text typing;
- mouse move/click/double-click/press/drag/scroll;
- optional macOS gestures;
- FPS/frame-time diagnostics.

Reimplementing those would add maintenance without creating value. The MCP should translate stable tool calls into these BRP methods and convert results into agent-friendly MCP content.

## Runtime capability model

The MCP never assumes that every runtime can render or receive input.

`get_runtime_status` returns a capability record shaped around these flags:

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

Typical full Bevy app:

```json
{
  "process": true,
  "ecsRead": true,
  "ecsWrite": true,
  "registrySchema": true,
  "app": true,
  "render": true,
  "input": true,
  "virtualTime": true,
  "diagnostics": true,
  "gracefulShutdown": true
}
```

Typical standalone ECS host:

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

A tool whose capability is unavailable returns a normal structured `unsupported_capability` result. It does not pretend to emulate missing renderer/input behavior.

## Full Bevy application integration

### Preferred integration

The companion `bevy_mcp_bridge` crate exposes a small `BevyMcpPlugin` behind a `full` feature.

Application setup is intentionally one line after the dependency is present:

```rust
App::new()
    .add_plugins(DefaultPlugins)
    .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
    .run();
```

`BevyMcpPlugin` is a composition wrapper, not a replacement protocol implementation. It:

1. adds `bevy_brp_extras::BrpExtrasPlugin`, which composes with an existing `RemotePlugin`/`RemoteHttpPlugin` when present;
2. registers the small generic `bevy_mcp/*` methods this project actually owns: runtime capabilities, virtual-time control, and world statistics;
3. binds native HTTP to loopback only;
4. uses port `15702` by default and honors `BEVY_MCP_PORT` when configured.

Existing projects that already expose standard BRP can be debugged without the bridge crate for BRP-native operations. The MCP probes `rpc.discover` and infers a reduced capability set when `bevy_mcp/capabilities` is absent. Installing `bevy_mcp_bridge` upgrades that experience but is not a prerequisite for basic BRP access.

### Reflection requirement

BRP and this MCP can only generically inspect values that Bevy can reflect and that are registered in the application's type registry.

Game/runtime types intended for generic inspection should use normal Bevy reflection patterns, for example:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct Health {
    current: i32,
    max: i32,
}

app.register_type::<Health>();
```

The MCP will not add unsafe memory inspection to bypass reflection.

## Standalone `bevy_ecs` integration

### Host ownership

The host continues to own its `World` and schedules. `EcsBridge` does not wrap or replace them.

```rust
pub struct GameEngine {
    world: World,
    debug: EcsBridge,
}

impl GameEngine {
    pub fn update(&mut self) {
        self.debug.poll(&mut self.world);
        self.schedule.run(&mut self.world);
    }
}
```

Polling at a host-chosen safe boundary keeps all world reads/writes on the simulation thread and avoids `Arc<Mutex<World>>` ownership changes.

The host must poll regularly while it wants remote debugging to respond. Requests time out with a clear `runtime_not_polling` diagnostic if the host stops polling.

### Standalone reflection registry

`EcsBridge` owns a `TypeRegistry` used only for remote inspection/serialization. The host explicitly registers debug-visible components/resources:

```rust
let mut debug = EcsBridge::new()?;
debug.register_component::<Citizen>();
debug.register_resource::<SimClock>();
```

Registration APIs require normal Bevy `Reflect`/`GetTypeRegistration` support and install `ReflectComponent` or `ReflectResource` type data in the bridge registry.

This is deliberate: a generic debugger cannot safely serialize arbitrary unreflected Rust values. No derive macro or project-specific code generator is required in v1.

### Standalone wire contract

The standalone bridge speaks JSON-RPC 2.0 over loopback HTTP and intentionally mirrors standard BRP method names and payload shapes for the subset it supports.

Required v1 methods:

```text
rpc.discover
world.list_components
world.list_resources
world.get_components
world.get_resources
world.query
world.spawn_entity
world.despawn_entity
world.insert_components
world.remove_components
world.mutate_components
world.insert_resources
world.remove_resources
world.mutate_resources
registry.schema
bevy_mcp/capabilities
bevy_mcp/world_stats
```

The bridge does not claim support for standard BRP operations that are not implemented. `rpc.discover` is authoritative.

The MCP adapter uses method discovery/capabilities rather than runtime-name heuristics.

### Standalone transport

The bridge HTTP listener runs on a small background thread and owns no `World` access.

```text
HTTP thread
  receive JSON-RPC request
        |
        v
  request channel ------------------+
                                    |
                                    v
                              EcsBridge::poll
                              &mut World access
                                    |
                                    v
  response channel <----------------+
        |
        v
HTTP response
```

Default address is `127.0.0.1:15702`. V1 does not expose a bind-all-address option.

The implementation should use a small existing synchronous HTTP dependency rather than hand-writing HTTP parsing or introducing a full async runtime solely for the debug server.

## MCP server responsibilities

The Node process owns five concerns only:

1. Cargo workspace/target discovery;
2. managed child-process lifecycle and logs;
3. runtime probing/capability negotiation;
4. generic MCP tool validation and BRP/bridge translation;
5. plugin/package metadata and screenshot result conversion.

It does not contain Bevy simulation code.

## Cargo target discovery

Use `cargo metadata --no-deps --format-version=1` as the authority.

`list_bevy_targets` returns executable packages/targets with:

```ts
interface BevyTarget {
  packageName: string;
  manifestPath: string;
  targetName: string;
  kind: "bin" | "example";
  runtimeKind: "full_bevy" | "standalone_ecs" | "unknown";
}
```

`runtimeKind` is a convenience inferred from direct dependencies (`bevy`, `bevy_ecs`) and never authorizes runtime operations. Live capabilities come from the running endpoint.

No recursive source-code parser is needed for project discovery.

## Process lifecycle

The MCP may manage one active child process per MCP server process in v1.

`run_bevy`:

- resolves an exact package/target returned by `list_bevy_targets`;
- spawns `cargo run` with the proper `-p`, `--bin`, or `--example` arguments;
- forwards optional application arguments after `--`;
- sets `BEVY_MCP_PORT` and `BRP_EXTRAS_PORT` to the selected runtime port for compatibility;
- captures stdout and stderr into a bounded in-memory tail plus a temp log file;
- returns immediately after spawn and reports PID/log path.

`stop_bevy`:

1. attempts generic graceful shutdown when the runtime advertises it;
2. waits only for a short fixed grace period;
3. terminates the managed child if still alive.

`restart_bevy` reuses the last resolved launch specification. It is not a second process-management implementation.

External processes can be inspected through a known port but cannot have historical stdout/stderr captured retroactively.

## MCP tool surface

Keep tools explicit enough for agents to discover, but avoid one tool per BRP verb when a cohesive operation can carry an enum.

### Project and process

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

`query_entities` is the primary generic world inspection tool. It accepts:

```ts
interface QueryEntitiesInput {
  port?: number;
  components?: string[];
  with?: string[];
  without?: string[];
  limit?: number;
}
```

`components` controls returned values. `with`/`without` are filters. `limit` defaults to `200` and may not exceed `2000`, preventing an accidental 200k-entity response from dominating agent context.

The response includes `matched` when the backend can cheaply compute it and a `truncated` flag when the limit cuts results.

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

These remain generic reflection operations. There is no game-aware validation layer.

`mutate_component`/`mutate_resource` use Bevy reflection paths and replace exactly one field/value path per call. Bulk patch languages are out of scope.

### Game/app control

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
  | { action: "pause" }
  | { action: "resume" }
  | { action: "set_scale"; scale: number };
```

`scale` must be finite and greater than zero.

V1 intentionally does not expose `step_frame`: pausing Bevy virtual time does not stop arbitrary systems scheduled every frame, so a generic single-frame semantic would be misleading.

`mouse_input` accepts an action enum:

```text
move
click
double_click
button_down
button_up
drag
scroll
```

It translates to the existing `bevy_brp_extras` methods. No OS accessibility APIs are used.

### Diagnostics and protocol escape hatch

```text
get_diagnostics
list_remote_methods
call_remote_method
```

`list_remote_methods` maps to `rpc.discover`.

`call_remote_method` is a raw JSON-RPC escape hatch for protocol-level experimentation. The MCP itself still defines no project-specific operations. The tool accepts a discovered method name and raw JSON parameters and returns the raw result/error.

This avoids adding a new MCP release every time standard BRP gains another method.

## Screenshots

`capture_screenshot` is a first-class MCP tool for full Bevy apps.

Input supports:

```ts
interface ScreenshotInput {
  port?: number;
  cameraEntity?: number;
  entity?: number;
  padding?: number;
}
```

Behavior:

- no camera/entity: capture primary window;
- camera only: capture that camera viewport;
- entity: crop to the entity as rendered by the selected/eligible camera;
- padding: non-negative physical-pixel expansion.

The MCP creates a temp `.png` path, calls `brp_extras/screenshot`, reads the completed PNG, and returns MCP image content (`image/png`). The temp file is deleted after the payload is read.

The tool returns `unsupported_capability` for standalone ECS instead of falling back to an OS screenshot.

## Input control

Keyboard and mouse control are injected through Bevy's input/event stack via `bevy_brp_extras`, not through native OS event synthesis. This keeps input deterministic and avoids platform accessibility permissions.

`type_text` remains distinct from `send_keys` because sequential text entry and chord/key input are materially different agent actions.

## Virtual-time control

The full bridge owns three generic BRP methods around `Time<Virtual>`:

```text
bevy_mcp/time_pause
bevy_mcp/time_resume
bevy_mcp/time_set_scale
```

They call Bevy's virtual-time API and report the resulting pause state/relative speed.

Standalone ECS does not advertise virtual-time control because a bare `World` has no universal time resource or scheduling contract.

## World statistics

`get_world_stats` should stay cheap and generic.

V1 response:

```ts
interface WorldStats {
  entityCount: number;
  archetypeCount: number;
  registeredComponentCount: number;
  registeredResourceCount: number;
  componentEntityCounts: Array<{
    typePath: string;
    entityCount: number;
  }>;
}
```

The component rows are sorted by descending entity count then type path. This makes large-ECS debugging useful without serializing entity payloads.

Do not add per-system profiling or historical sampling in v1.

## Errors

Every MCP tool returns a stable top-level error code instead of leaking arbitrary transport/process exceptions as the main contract.

Required codes:

```text
invalid_request
target_not_found
process_not_running
process_already_running
runtime_unreachable
runtime_not_polling
unsupported_capability
remote_method_not_found
remote_error
timeout
io_error
cargo_error
```

The response may include a human-readable diagnostic and raw remote error data when useful.

Transport errors do not crash the MCP server.

## Timeouts and bounded work

Use fixed, short local-debug defaults:

- runtime HTTP request: 5 seconds;
- standalone bridge request waiting for host polling: 5 seconds;
- graceful shutdown before child termination: 2 seconds;
- query default row limit: 200;
- query hard row limit: 2000;
- debug output default: last 200 lines;
- debug output hard maximum: 5000 lines.

No retry framework is needed. A user or agent can call again after fixing the runtime.

## Security posture

This is development tooling with intentional mutation/control capabilities.

V1 security boundary is intentionally small:

- bind runtime HTTP only to `127.0.0.1`;
- expose no authentication/remote-network mode;
- never execute an arbitrary shell string supplied as one field;
- construct Cargo child arguments as an argv array;
- do not provide a generic filesystem write tool;
- only screenshot paths created by the MCP are used by `capture_screenshot`;
- clearly document that any local process able to reach the debug port can mutate the reflected world.

No TLS, token system, permission matrix, sandbox, or policy engine is added for a localhost hobby/development workflow.

## Project integration workflow

V1 favors reliable explicit integration over fragile arbitrary Rust source rewriting.

`get_bridge_status` inspects the selected Cargo package and live runtime and reports one of:

```text
full_bridge
brp_only
standalone_bridge
dependency_only
not_configured
version_mismatch
```

`install_bridge_dependency` may add the exact compatible `bevy_mcp_bridge` dependency to the selected package through `cargo add`. It does **not** guess where to rewrite arbitrary app/engine construction code.

The result returns the exact minimal Rust snippet for the detected integration kind:

- full Bevy: add `BevyMcpPlugin` to the app;
- standalone ECS: construct/register `EcsBridge` and poll it at a safe world boundary.

Automatic source insertion can be reconsidered after real projects show a reliable common seam. It is not needed to make the first release useful.

## MCP/plugin packaging

Mirror the proven distribution shape of `godot-mcp` while using current MCP/Agent Plugins versions.

Repository root contains:

```text
plugin.json
mcp.json
```

`mcp.json` declares one stdio server using:

```text
npx -y @cwchanap/bevy-plugin@<version>
```

The npm package exposes one binary:

```text
bevy-plugin
```

and contains the compiled MCP server plus plugin metadata needed by installers.

Client wrappers do not fork the MCP implementation:

- Agent Plugins 1.0 root metadata for portable clients/Pi-compatible tooling;
- Codex marketplace wrapper metadata;
- Claude Code marketplace wrapper metadata;
- direct stdio MCP remains supported for any client.

The exact marketplace file layout should follow the current `cwchanap/godot-mcp` repository so both plugins are maintained consistently.

## Repository layout

Keep the new repository modular but small:

```text
README.md
LICENSE
package.json
tsconfig.json
plugin.json
mcp.json

src/
  index.ts                 # stdio bootstrap only
  server.ts                # MCP server/tool registration
  project/
    cargo.ts               # cargo metadata + target resolution
    process-manager.ts     # one managed child + bounded logs
  runtime/
    client.ts              # JSON-RPC/BRP HTTP client
    capabilities.ts        # probe + normalize runtime capabilities
    errors.ts              # stable error mapping
  tools/
    project.ts             # project/process MCP handlers
    world.ts               # ECS read/write MCP handlers
    control.ts             # time/input/shutdown handlers
    visual.ts              # screenshot handler
    diagnostics.ts         # diagnostics/world stats/protocol discovery
  packaging/
    metadata.ts            # shared version/package metadata checks

crates/
  bevy-mcp-bridge/
    Cargo.toml
    src/
      lib.rs               # public exports/features
      full.rs              # BevyMcpPlugin composition + generic methods
      ecs.rs               # EcsBridge + reflection registration/polling
      protocol.rs          # JSON-RPC request/response + shared method names
      reflect.rs           # standalone reflected world operations
      server.rs            # loopback HTTP thread/channels

fixtures/
  full-app/
  ecs-only/

tests/
  ... focused TypeScript unit/integration tests ...

plugins/bevy-plugin/.mcp.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

Do not introduce a monorepo framework, code generator, shared abstraction package, database, daemon, or web UI.

## Testing strategy

### TypeScript unit tests

Cover without launching Bevy:

- Cargo metadata target parsing/resolution;
- argv construction for bins/examples/workspace packages;
- one-process lifecycle and bounded log tail;
- JSON-RPC success/error/timeout mapping;
- capability inference for full bridge, BRP-only, and standalone bridge;
- query limits;
- screenshot temp-file cleanup and MCP image payload conversion using a fake runtime client;
- MCP tool validation/error contracts;
- plugin/package metadata version consistency.

### Rust unit tests

For `EcsBridge` and reflection helpers:

- component/resource registration;
- list/get/query reflected values;
- include/exclude query filters;
- spawn/despawn;
- insert/remove/mutate component;
- insert/remove/mutate resource;
- schema/type information;
- world stats ordering/counts;
- unsupported method discovery;
- request timeout when `poll` is not serviced;
- loopback-only server configuration.

For the full plugin:

- capability method values;
- virtual-time pause/resume/set-scale semantics;
- composition does not duplicate an existing BRP setup.

### Native integration fixtures

`fixtures/full-app` is a tiny Bevy 0.19 app with reflected test components, one controllable UI/window surface, and `BevyMcpPlugin`.

A single integration journey proves:

1. discover and launch the fixture;
2. connect and read capabilities;
3. query a reflected entity;
4. mutate a reflected value and read it back;
5. pause/resume virtual time;
6. send one keyboard action;
7. send one mouse action;
8. capture a PNG and verify non-empty PNG bytes/dimensions;
9. read debug output;
10. gracefully shut down.

Run visual fixture tests under `xvfb-run` on Linux CI rather than adding a custom headless renderer solely for tests.

`fixtures/ecs-only` owns a `World`, registers one component and resource, polls `EcsBridge`, and proves the same generic world query/mutation calls without any Bevy `App` or renderer dependency.

### Package smoke

Pack the npm tarball and execute the packed CLI with `--help`/server startup smoke. Validate `plugin.json`, `mcp.json`, Codex wrapper, and Claude wrapper all point to the same package version.

## CI gates

Initial repository CI should run:

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

If the full integration fixture makes ordinary `cargo test --workspace` attempt to open a window, keep that fixture binary out of default test execution and launch it only from the explicit integration command.

## Documentation

README quick start must show:

1. direct MCP invocation with `npx`;
2. Agent Plugins/Codex/Claude installation paths;
3. full Bevy app integration snippet;
4. standalone ECS integration snippet;
5. reflection registration requirement;
6. generic tool categories;
7. localhost/debug-security warning;
8. supported Bevy version.

No per-game examples in the first release README.

## Delivery boundary

This design is implemented in **one implementation PR**. Multiple task commits are expected inside that PR; do not split the ticket across multiple PRs.

The first release candidate is complete when:

- one npm MCP server exposes the generic tools in this spec;
- one Rust bridge crate supports full Bevy and standalone ECS integration;
- full Bevy reuses standard BRP + `bevy_brp_extras` rather than reimplementing screenshot/input;
- standalone ECS exposes the required BRP-shaped reflected subset over loopback HTTP;
- capability negotiation makes unsupported features explicit;
- project launch/log lifecycle works for Cargo bins/examples;
- the full fixture proves ECS read/write, control, input, screenshot, logs, and shutdown;
- the standalone fixture proves ECS read/write without `bevy_app`/renderer ownership;
- Agent Plugins/Codex/Claude package metadata all invoke the same npm binary;
- native automated gates pass;
- no game-specific method exists in the MCP or bridge.

## References

- Bevy 0.19 remote protocol: https://docs.rs/bevy_remote/0.19.1/bevy_remote/
- Bevy 0.19 HTTP BRP transport: https://docs.rs/bevy_remote/0.19.1/bevy_remote/http/struct.RemoteHttpPlugin.html
- `bevy_brp_extras` 0.22.3: https://docs.rs/bevy_brp_extras/0.22.3/bevy_brp_extras/
- `bevy_brp_mcp` 0.22.x reference implementation: https://docs.rs/bevy_brp_mcp/latest/bevy_brp_mcp/
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Agent Plugins 1.0 specification: https://agent-plugins.org/specification
