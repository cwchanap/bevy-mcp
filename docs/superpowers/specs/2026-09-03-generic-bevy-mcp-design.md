# Generic Bevy MCP Design

## Status

Revised after reuse review on September 4, 2026.

V1 remains a **generic Bevy developer MCP/plugin**, with no Scorpius-, Caelum-, or other game-specific operations. The major architecture correction is that this repository will **not implement another general BRP MCP server**.

The current published Bevy 0.19-compatible upstream is `bevy_brp_mcp` **0.22.3**. It already owns nearly all generic functionality previously planned here: Bevy target discovery/launch, process/log management, reflected ECS read/write/query operations, component watching, type guides, `rpc.discover`, a discovery-validated raw BRP escape hatch, and passthroughs for `bevy_brp_extras` screenshot/input/diagnostics/shutdown.

This repository therefore owns only the missing generic value:

1. a small Rust `bevy-mcp-bridge` plugin that registers bounded world statistics and virtual-time control as application BRP methods and publishes typed agent metadata for them; and
2. an npm/Agent-Plugins distribution wrapper so Codex, Claude Code, Cursor, and other MCP clients can install one familiar plugin entrypoint while delegating the actual MCP server to upstream `bevy_brp_mcp`. Pi is also supported, but not via built-in MCP support (Pi has none): the community `pi-mcp-adapter` + `pi-agent-plugins` packages provide the MCP runtime and Agent Plugins loader, after which the user installs and trusts this repository's portable package (`/plugin install github.com/cwchanap/bevy-mcp` then `/plugin trust bevy-plugin`) so its Agent Plugins 1.0 `plugin.json` / root `mcp.json` is projected to `pi-mcp-adapter`. The same portable package is therefore the Pi integration path.

## Review resolutions

The review findings are incorporated as follows:

1. **Reuse `bevy_brp_mcp`.** The previously planned TypeScript MCP server, Cargo discovery, process manager, JSON-RPC client, capability layer, ECS tool translations, screenshot handling, and raw BRP execution are deleted from the design. Upstream already ships stronger versions of those capabilities.
2. **Use the published version that actually exists.** The review references `bevy_brp_mcp` 0.22.5, but the current published Bevy 0.19 line is 0.22.3. V1 pins 0.22.3 until an explicit update is made.
3. **Fix Bevy dependency assumptions.** `bevy_time` is not a feature of the top-level Bevy 0.19.1 crate. The bridge depends on the focused Bevy subcrates it directly uses (`bevy_app`, `bevy_ecs`, `bevy_remote`, `bevy_time`) plus `bevy_brp_extras`; it does not guess a nonexistent `bevy_time` feature.
4. **Follow the upstream agent-tool registration example exactly.** `BevyMcpPlugin` adds `BrpExtrasPlugin`, registers each system, inserts `RemoteMethodSystemId::Instant` entries into `RemoteMethods` inside a bounded mutable borrow, then publishes both methods through `AppAgentToolExt::register_agent_tool` with `AgentTool` schemas.
5. **Create a real full-Bevy fixture in the first implementation task.** Runtime assumptions are exercised against an actual Bevy app from the beginning rather than after several mock-only layers.
6. **Drop screenshot validation code from this repo.** The repository no longer receives or translates screenshot payloads; upstream `bevy_brp_mcp`/`bevy_brp_extras` own that path. No duplicate PNG parser or size policy is added here.
7. **Bound `world_stats`.** Component counts are returned as a top-N list (default 50, maximum 500) with `returned` and `truncated`, not an unbounded map.
8. **Drop dead `runtimeKind` and the local MCP error union.** Those belonged to the deleted TypeScript translation layer.
9. **Keep one PR.** The suggestion to split the six prior task groups is intentionally not adopted. Project workflow is one task/ticket = one PR; the implementation is now small enough that PR #1 is also materially easier to review.

## Context

The product goal is analogous to `cwchanap/godot-mcp`: a reusable agent plugin that can be installed for local game-development workflows and applied across projects.

The upstream Bevy ecosystem already supplies the generic runtime tooling:

### `bevy_brp_mcp` 0.22.3

For Bevy 0.19, upstream already provides MCP tools for:

- discovering Bevy apps/examples (`brp_list_bevy`);
- launching them (`brp_launch`);
- process status and temp-file log capture (`read_log` and related log/process tools);
- entity/component/resource query and mutation;
- `world_find_entities_by_name`;
- component watching;
- `brp_type_guide` / type mutation guidance;
- exhaustive `rpc.discover`;
- `brp_execute`, which checks live discovery before forwarding raw BRP params;
- `brp_list_agent_tools` for app-published typed agent metadata;
- all supported `bevy_brp_extras` control/visual/diagnostic methods.

Recreating this surface in TypeScript would make this project a weaker fork that permanently tracks Bevy/BRP changes. V1 does not do that.

### `bevy_brp_extras` 0.22.3

The app-side extras plugin already supplies:

- BRP/HTTP composition on native targets;
- screenshot capture;
- graceful shutdown;
- keyboard and text input;
- mouse move/click/double-click/timed press/drag/scroll;
- optional macOS gestures;
- FPS/frame-time diagnostics;
- `brp_extras/agent_tools`;
- `AgentTool` and `AppAgentToolExt::register_agent_tool` for publishing typed application BRP methods.

The bridge composes this plugin instead of copying any of those features.

## Product goal

After v1, a developer should be able to:

1. install the upstream runtime MCP once with Cargo;
2. install this repository's Codex/Claude/Agent-Plugins wrapper through the same marketplace-style workflow used by `godot-mcp`;
3. add one Git dependency and one `BevyMcpPlugin` line to a Bevy 0.19 game;
4. use upstream generic MCP tools for launch/logs/ECS inspection and mutation/screenshots/input/diagnostics;
5. discover the bridge's two additional generic methods through `brp_list_agent_tools`;
6. execute bounded world statistics or virtual-time control through `brp_execute`.

There is one generic debugging ecosystem rather than two parallel MCP contracts.

## Non-goals

V1 does **not** include:

- a reimplementation or fork of `bevy_brp_mcp`;
- a TypeScript BRP client or MCP tool translation layer;
- local Cargo target discovery/process/log management;
- local ECS read/write/query tools;
- local screenshot/input/diagnostics/shutdown handling;
- application/game-specific debug commands;
- standalone `bevy_ecs::World` transport;
- save manipulation, gameplay assertions, or test DSLs;
- deterministic replay or `step_frame`;
- render/frame/schedule profiling;
- WASM/browser relay;
- source rewriting or automatic project integration;
- Bevy-version compatibility shims;
- a cross-engine abstraction shared with Godot;
- publishing the Rust bridge to crates.io in v1.

## Compatibility baseline

V1 pins:

- Bevy: `0.19.1` / `0.19.x`
- `bevy_brp_mcp`: `0.22.3`
- `bevy_brp_extras`: `0.22.3`
- Rust: `>=1.95.0`, edition 2024
- Node.js: `>=20`
- Agent Plugins metadata: `1.0.0`
- native macOS/Linux/Windows debugging

A future Bevy release is an explicit dependency-update task rather than a compatibility layer.

## Architecture

```text
Codex / Claude Code / Pi / Cursor / MCP client
                         |
                         | plugin metadata
                         v
              @cwchanap/bevy-plugin
                thin Node launcher
                         |
                         | inherited stdio (no MCP parsing)
                         v
                bevy_brp_mcp 0.22.3
                    upstream MCP
                         |
                         | BRP / localhost HTTP
                         v
                  Bevy 0.19 app
                         |
         +---------------+----------------+
         |                                |
  BrpExtrasPlugin                  BevyMcpPlugin
  screenshot/input/...          world_stats + time_control
                                          |
                                   published AgentTool
                                   descriptions/schemas
```

### Ownership boundary

**Upstream `bevy_brp_mcp` owns:**

- MCP protocol/server implementation;
- Bevy discovery/launch/process/log behavior;
- generic BRP ECS tools;
- watches and type guides;
- `rpc.discover` and `brp_execute`;
- generic `bevy_brp_extras` passthroughs.

**This repository's Rust crate owns:**

- `bevy_mcp/world_stats`;
- `bevy_mcp/time_control`;
- typed agent-tool metadata for those two methods;
- a convenience plugin composing `BrpExtrasPlugin`.

**This repository's npm package owns only:**

- locating and starting `bevy_brp_mcp` over inherited stdio;
- an actionable missing-binary error;
- portable Agent Plugins/Codex/Claude packaging.

It does not proxy, inspect, rename, filter, or wrap MCP messages.

## Thin npm launcher

Package:

```text
@cwchanap/bevy-plugin
```

Its executable is deliberately tiny.

Resolution order:

1. `BEVY_BRP_MCP_BIN` when set;
2. otherwise `bevy_brp_mcp` from `PATH`.

The launcher spawns the resolved command with:

```text
stdin  = inherit
stdout = inherit
stderr = inherit
```

and passes through any command-line arguments. It waits for the upstream process and mirrors its exit status.

If spawning fails with `ENOENT`, it prints the exact prerequisite:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

and exits non-zero.

V1 deliberately does **not** run `cargo install` automatically from npm. Hidden global toolchain mutation and a long first-run compile are worse than one explicit prerequisite. If this proves to be meaningful installation friction, prebuilt upstream binaries or a bundled distribution can be evaluated separately.

## Agent-plugin distribution

The repository mirrors the metadata shape already used by `godot-mcp`:

```text
plugin.json
mcp.json
plugins/bevy-plugin/.mcp.json
plugins/bevy-plugin/.codex-plugin/plugin.json
plugins/bevy-plugin/.claude-plugin/plugin.json
.agents/plugins/marketplace.json
.claude-plugin/marketplace.json
```

Every wrapper invokes:

```text
npx -y @cwchanap/bevy-plugin@0.1.0
```

which delegates stdio to the Cargo-installed upstream MCP binary.

There is no client-specific server implementation.

The npm package is published on GitHub Release or an explicit manual publish trigger, matching the existing Godot plugin release pattern.

## Companion Rust crate

Repository crate:

```text
crates/bevy-mcp-bridge
```

Public API:

```rust
pub struct BevyMcpPlugin;
```

Consumer integration:

```toml
[dependencies]
bevy-mcp-bridge = { git = "https://github.com/cwchanap/bevy-mcp" }
```

```rust
App::new()
    .add_plugins(DefaultPlugins)
    .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
    .run();
```

The game must enable Bevy PNG support for screenshot functionality supplied by `bevy_brp_extras`.

### Bridge dependencies

Do not use a guessed top-level Bevy feature list. The bridge declares the focused crates it directly needs:

```toml
bevy_app = "0.19.1"
bevy_ecs = "0.19.1"
bevy_remote = "0.19.1"
bevy_time = "0.19.1"
bevy_brp_extras = "0.22.3"
schemars = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

The fixture separately uses normal `bevy = "0.19.1"` with the `png` feature.

There is no nonexistent `bevy_time` feature on the top-level Bevy crate.

## Remote-method registration

`BevyMcpPlugin::build` follows `bevy_brp_extras/examples/agent_tool_registration.rs` as the normative pattern:

1. add `BrpExtrasPlugin`;
2. register each instant handler as a Bevy system;
3. borrow `RemoteMethods` only long enough to insert both `RemoteMethodSystemId::Instant(system_id)` entries;
4. end that mutable resource borrow;
5. call `app.register_agent_tool(...)` for each method.

The required shape is:

```rust
let world_stats_id = app.world_mut().register_system(world_stats);
let time_control_id = app.world_mut().register_system(time_control);
{
    let mut remote_methods = app.world_mut().resource_mut::<RemoteMethods>();
    remote_methods.insert(
        "bevy_mcp/world_stats",
        RemoteMethodSystemId::Instant(world_stats_id),
    );
    remote_methods.insert(
        "bevy_mcp/time_control",
        RemoteMethodSystemId::Instant(time_control_id),
    );
}

app.register_agent_tool(
    AgentTool::new(
        "bevy_mcp_world_stats",
        "bevy_mcp/world_stats",
        "Return bounded aggregate ECS world statistics",
    )
    .params_schema_for::<WorldStatsParams>()
    .result_schema_for::<WorldStatsResult>(),
);
```

`time_control` is published the same way with its own typed params/result schemas.

No custom MCP tool registration is required; upstream agents discover these records through `brp_list_agent_tools` and invoke their backing methods with `brp_execute`.

## `bevy_mcp/world_stats`

### Input

```rust
pub struct WorldStatsParams {
    pub limit: Option<usize>,
}
```

Rules:

- default: `50`;
- minimum: `1`;
- maximum: `500`;
- invalid values return BRP `INVALID_PARAMS`.

### Result

```rust
pub struct ComponentCount {
    pub name: String,
    pub entities: usize,
}

pub struct WorldStatsResult {
    pub entities: u32,
    pub archetypes: usize,
    pub components: Vec<ComponentCount>,
    pub returned: usize,
    pub truncated: bool,
}
```

Algorithm:

1. resolve the `ComponentId` for `IsResource` (the marker Bevy 0.19 attaches to resource-backed entities);
2. iterate only populated archetypes (`!archetype.is_empty()`);
3. skip any archetype whose component set contains `IsResource`, so resource entities/archetypes are excluded from both totals (in Bevy 0.19 resources are entity-backed, so raw `World::entity_count()` / `World::archetypes().len()` would otherwise include them);
4. `entities` is the sum of `archetype.len()` over the remaining archetypes;
5. `archetypes` is the count of remaining archetypes;
6. add each remaining archetype's entity count to every non-resource component ID present in that archetype;
7. resolve names through `World::components()` metadata;
8. sort by entity count descending, then component name ascending;
9. truncate to `limit`;
10. set `returned` and `truncated` explicitly.

No history, timings, profiler data, or resource dump is added.

## `bevy_mcp/time_control`

### Input

```rust
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TimeControlParams {
    Pause,
    Resume,
    SetScale { scale: f32 },
}
```

`set_scale` requires a finite value strictly greater than zero and returns `INVALID_PARAMS` before calling Bevy for invalid input.

### Behavior

Use `Time<Virtual>`:

- pause -> `pause()`;
- resume -> `unpause()`;
- set_scale -> `set_relative_speed(scale)`.

### Result

```rust
pub struct TimeControlResult {
    pub paused: bool,
    pub relative_speed: f32,
}
```

There is no `step_frame`. Pausing virtual time does not stop arbitrary systems scheduled every frame.

## Reflection boundary

Generic ECS inspection remains upstream BRP behavior. Game-owned types must be reflectable and registered normally, for example:

```rust
#[derive(Component, Reflect)]
#[reflect(Component)]
struct Health {
    current: i32,
    max: i32,
}

app.register_type::<Health>();
```

`BevyMcpPlugin` does not make opaque values inspectable and does not add unsafe memory inspection or a second serialization registry.

## Full-app fixture

The first implementation task creates:

```text
fixtures/full-app
```

It is a real Bevy 0.19 app using `BevyMcpPlugin` and contains:

- one reflected component;
- one reflected resource;
- at least two entities with different component combinations so `world_stats` counts are meaningful;
- virtual time through normal Bevy plugins;
- a camera and visible primitive so upstream screenshot/input tools have a real runtime target.

The fixture exists from Task 1 onward so subsequent tests can verify assumptions against a live app instead of only local mocks.

## Real MCP integration journey

The final automated journey uses the published upstream server rather than a fake BRP client.

CI installs:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

Then a real MCP client starts the npm wrapper and performs:

1. MCP initialize/list-tools; assert upstream tools such as `brp_list_bevy`, `brp_launch`, `world_query`, `brp_list_agent_tools`, and `brp_execute` exist;
2. `brp_list_bevy` against this repository and find `fixtures/full-app`;
3. `brp_launch` the fixture on port 15702;
4. use a normal upstream ECS query against the reflected fixture type;
5. call `brp_list_agent_tools` and find both `bevy_mcp_world_stats` and `bevy_mcp_time_control` with schemas;
6. invoke world stats through `brp_execute` with `limit: 1` and assert `returned == 1` plus `truncated == true` when the fixture has more component types;
7. invoke pause/resume/set-scale through `brp_execute` and verify result state;
8. call at least one upstream extras operation (screenshot or diagnostics) to prove `BevyMcpPlugin` composition did not regress extras;
9. gracefully shut down the fixture.

On Linux this runs under Xvfb.

## Future standalone `bevy_ecs`

Standalone ECS remains a future extension, not v1 scope.

When a real caller-owned `bevy_ecs::World` consumer exists, the intended design is:

```text
loopback HTTP thread -> request channel -> host EcsBridge::poll(&mut World)
                                      -> bevy_remote::builtin_methods
```

The future bridge must reuse public `bevy_remote::builtin_methods` handlers and `AppTypeRegistry` semantics. It must not create a private BRP serializer/query/mutation implementation.

That future work is justified by an actual standalone consumer, not by speculative parity.

## Delivery

This task stays on existing draft PR #1 and branch `agent/generic-bevy-mcp-design`.

Implementation is complete when the same PR contains:

- `bevy-mcp-bridge` with the two bounded generic methods and typed agent metadata;
- the live full-app fixture;
- the thin npm launcher and Agent Plugins/Codex/Claude metadata;
- real upstream-MCP integration coverage;
- README setup for Cargo + plugin installation + reflection;
- CI gates for Rust, npm wrapper, and real MCP integration;
- npm release publishing;
- no local BRP/MCP reimplementation and no game-specific tools.

One task = one PR remains the delivery rule.