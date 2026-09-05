# Generic Bevy MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reusable Bevy 0.19 agent plugin without reimplementing the existing Bevy BRP MCP: add two missing generic BRP methods (`world_stats` and virtual-time control), package them in one Bevy plugin, and provide an npm/Codex/Claude/Agent-Plugins launcher that delegates stdio to upstream `bevy_brp_mcp` 0.22.3.

**Architecture:** `bevy_brp_mcp` remains the real MCP server and owns discovery, launch/logs, ECS inspection/mutation, watches, type guides, raw BRP execution, screenshots, input, diagnostics, and shutdown. This repository owns a small `bevy-mcp-bridge` Rust crate that composes `BrpExtrasPlugin` and publishes two typed application BRP methods, plus a dependency-free Node launcher that starts the Cargo-installed upstream MCP binary with inherited stdio. A real full-Bevy fixture exists from Task 1 and is used for the final MCP journey.

**Tech Stack:** Rust >=1.95, edition 2024, Bevy 0.19.1 subcrates, `bevy_brp_extras` 0.22.3, upstream `bevy_brp_mcp` 0.22.3, Node.js >=20, `@modelcontextprotocol/client` 2.0.0 for integration tests, Agent Plugins 1.0.0, GitHub Actions/Xvfb.

**Spec:** `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`

## Global Constraints

- Continue implementation on existing draft PR #1 and branch `agent/generic-bevy-mcp-design`; do not open another PR for this task.
- V1 targets Bevy 0.19.x and pins upstream `bevy_brp_mcp` / `bevy_brp_extras` to 0.22.3.
- Do not implement a second MCP server, BRP client, Cargo discovery layer, process manager, ECS tool layer, screenshot handler, capability model, or local error taxonomy.
- Do not add game-specific operations.
- Do not add standalone `bevy_ecs` transport in v1.
- `BevyMcpPlugin` owns only `bevy_mcp/world_stats` and `bevy_mcp/time_control` plus their agent metadata.
- `world_stats` defaults to 50 component rows and caps at 500.
- `time_control set_scale` accepts only finite values greater than zero.
- The npm launcher must not parse or proxy MCP messages and must not automatically run `cargo install`.
- The Rust bridge remains a Git dependency in v1; no crates.io publish task.
- npm release publication is included so Agent Plugins metadata points at a real package.

---

## Planned file structure

```text
Cargo.toml
LICENSE
README.md
package.json
package-lock.json
plugin.json
mcp.json

crates/bevy-mcp-bridge/
  Cargo.toml
  src/lib.rs
  src/methods.rs
  tests/methods.rs

fixtures/full-app/
  Cargo.toml
  src/main.rs

bin/
  bevy-plugin.mjs
src/
  launcher.mjs
test/
  launcher.test.mjs
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

There is no `src/server.ts`, BRP transport/client module, tool registry, `runtimeKind`, PNG parser, or standalone ECS fixture.

---

### Task 1: Build the Rust bridge and live Bevy fixture first

**Files:**
- Create: `Cargo.toml`
- Create: `LICENSE`
- Create: `crates/bevy-mcp-bridge/Cargo.toml`
- Create: `crates/bevy-mcp-bridge/src/lib.rs`
- Create: `crates/bevy-mcp-bridge/src/methods.rs`
- Create: `crates/bevy-mcp-bridge/tests/methods.rs`
- Create: `fixtures/full-app/Cargo.toml`
- Create: `fixtures/full-app/src/main.rs`

**Interfaces:**
- Produces `bevy_mcp_bridge::BevyMcpPlugin`.
- Produces BRP method `bevy_mcp/world_stats` with `WorldStatsParams` / `WorldStatsResult` schemas.
- Produces BRP method `bevy_mcp/time_control` with `TimeControlParams` / `TimeControlResult` schemas.
- Produces `fixtures/full-app` as the live target used by later integration tests.

- [ ] **Step 1: Create the Cargo workspace and exact dependency baseline**

Root `Cargo.toml`:

```toml
[workspace]
members = [
  "crates/bevy-mcp-bridge",
  "fixtures/full-app",
]
resolver = "3"
```

`crates/bevy-mcp-bridge/Cargo.toml`:

```toml
[package]
name = "bevy-mcp-bridge"
version = "0.1.0"
edition = "2024"
rust-version = "1.95"
license = "MIT"
publish = false

[dependencies]
bevy_app = "0.19.1"
bevy_ecs = "0.19.1"
bevy_remote = "0.19.1"
bevy_time = "0.19.1"
bevy_brp_extras = "0.22.3"
schemars = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Do **not** use a top-level `bevy` feature named `bevy_time`; it does not exist in Bevy 0.19.1.

`fixtures/full-app/Cargo.toml`:

```toml
[package]
name = "bevy-mcp-fixture"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
bevy = { version = "0.19.1", features = ["png"] }
bevy-mcp-bridge = { path = "../../crates/bevy-mcp-bridge" }
```

Run:

```bash
cargo check --workspace
```

Expected: manifests resolve on Rust >=1.95.

- [ ] **Step 2: Write RED tests for bounded world statistics**

In `crates/bevy-mcp-bridge/tests/methods.rs`, define two local components and construct a bare `World`:

```rust
#[derive(Component)]
struct Alpha;
#[derive(Component)]
struct Beta;

let mut world = World::new();
world.spawn((Alpha,));
world.spawn((Alpha, Beta));
```

Test the pure helper used by the BRP handler:

```rust
let result = collect_world_stats(&world, 1).unwrap();
assert_eq!(result.entities, 2);
assert_eq!(result.components.len(), 1);
assert_eq!(result.components[0].entities, 2);
assert_eq!(result.returned, 1);
assert!(result.truncated);
```

Also require deterministic count-descending/name-ascending ordering and reject `limit == 0` / `limit > 500`.

Run:

```bash
cargo test -p bevy-mcp-bridge --test methods world_stats
```

Expected: FAIL because the helper/types do not exist.

- [ ] **Step 3: Implement the bounded statistics model and helper**

In `src/methods.rs` define:

```rust
#[derive(Deserialize, JsonSchema)]
pub struct WorldStatsParams {
    pub limit: Option<usize>,
}

#[derive(Serialize, JsonSchema, Debug, PartialEq, Eq)]
pub struct ComponentCount {
    pub name: String,
    pub entities: usize,
}

#[derive(Serialize, JsonSchema, Debug, PartialEq, Eq)]
pub struct WorldStatsResult {
    pub entities: u32,
    pub archetypes: usize,
    pub components: Vec<ComponentCount>,
    pub returned: usize,
    pub truncated: bool,
}
```

Implement `collect_world_stats(&World, limit)` by accumulating each populated archetype's length into the component IDs it contains, resolving names through `world.components()`, then sorting and truncating. Defaulting to 50 belongs in the BRP handler; the pure helper receives a validated concrete limit.

Run the focused tests again; expected PASS.

- [ ] **Step 4: Write RED tests for virtual-time transitions**

Construct `Time::<Virtual>::default()` and lock:

```rust
let mut time = Time::<Virtual>::default();
apply_time_control(&mut time, TimeControlParams::Pause).unwrap();
assert!(time.is_paused());

apply_time_control(&mut time, TimeControlParams::Resume).unwrap();
assert!(!time.is_paused());

apply_time_control(
    &mut time,
    TimeControlParams::SetScale { scale: 2.0 },
).unwrap();
assert_eq!(time.relative_speed(), 2.0);
```

Also assert rejection for `0.0`, negative, `NaN`, and infinity before Bevy's setter can panic.

Run:

```bash
cargo test -p bevy-mcp-bridge --test methods time_control
```

Expected: FAIL before implementation.

- [ ] **Step 5: Implement typed time-control params/result and pure transition helper**

Use:

```rust
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TimeControlParams {
    Pause,
    Resume,
    SetScale { scale: f32 },
}

#[derive(Serialize, JsonSchema, Debug, PartialEq)]
pub struct TimeControlResult {
    pub paused: bool,
    pub relative_speed: f32,
}
```

`apply_time_control` calls `pause`, `unpause`, or validated `set_relative_speed` and returns the resulting state.

Run focused tests; expected PASS.

- [ ] **Step 6: Register the two BRP handlers using the upstream agent-tool example pattern**

Use `bevy_brp_extras/examples/agent_tool_registration.rs` as the normative reference. The registration sequence is exact:

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
```

Then publish:

```rust
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

Publish `bevy_mcp_time_control` analogously.

Each handler follows the same upstream signature style:

```rust
fn world_stats(In(params): In<Option<Value>>, world: &mut World) -> BrpResult
```

and maps missing/malformed/invalid params to `BrpError { code: INVALID_PARAMS, ... }`; serialization failure uses `BrpError::internal`.

`BevyMcpPlugin::build` adds `BrpExtrasPlugin` before registering/publishing these methods.

- [ ] **Step 7: Create the real fixture now, not at the end**

`fixtures/full-app/src/main.rs` must use `DefaultPlugins` + `BevyMcpPlugin`, register a reflected `FixtureMarker` component and `FixtureState` resource, spawn at least two entities with different component combinations, and spawn a camera plus visible primitive.

The fixture should include one ordinary update system that observes virtual time so pause/scale behavior can be validated later; do not add debug-only game semantics.

Run:

```bash
cargo check -p bevy-mcp-fixture
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add Cargo.toml LICENSE crates fixtures
git commit -m "feat: add generic Bevy MCP bridge"
```

---

### Task 2: Add the thin npm launcher and plugin metadata

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `bin/bevy-plugin.mjs`
- Create: `src/launcher.mjs`
- Create: `test/launcher.test.mjs`
- Create: `plugin.json`
- Create: `mcp.json`
- Create: `plugins/bevy-plugin/.mcp.json`
- Create: `plugins/bevy-plugin/.codex-plugin/plugin.json`
- Create: `plugins/bevy-plugin/.claude-plugin/plugin.json`
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces npm executable `bevy-plugin`.
- Resolves `BEVY_BRP_MCP_BIN` or `bevy_brp_mcp` from PATH.
- Delegates raw inherited stdio to upstream without MCP parsing.
- Produces Codex/Claude/Agent Plugins metadata using the same npm binary.

- [ ] **Step 1: Create a dependency-free runtime package plus client-only dev dependency**

`package.json`:

```json
{
  "name": "@cwchanap/bevy-plugin",
  "version": "0.1.0",
  "description": "Agent-plugin distribution wrapper for the Bevy BRP MCP and bevy-mcp bridge.",
  "type": "module",
  "license": "MIT",
  "bin": {
    "bevy-plugin": "bin/bevy-plugin.mjs"
  },
  "files": [
    "bin",
    "src",
    "plugin.json",
    "mcp.json"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "node --test test/*.test.mjs",
    "test:integration": "node scripts/integration.mjs",
    "smoke:packed": "node scripts/smoke-packed-cli.mjs"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0"
  }
}
```

Run `npm install` to create the lockfile.

- [ ] **Step 2: Write RED launcher tests**

Inject `spawnImpl` into `launchUpstream` and prove:

- default command is `bevy_brp_mcp`;
- `BEVY_BRP_MCP_BIN=/custom/brp` wins;
- CLI args are passed through unchanged;
- spawn uses `stdio: 'inherit'`;
- child exit code is mirrored;
- `ENOENT` emits exactly the prerequisite command `cargo install bevy_brp_mcp --version 0.22.3 --locked` and returns exit code 1.

No test should parse MCP JSON.

Run:

```bash
npm test
```

Expected: FAIL before launcher implementation.

- [ ] **Step 3: Implement the launcher only**

`src/launcher.mjs` should expose a small injectable function around `child_process.spawn`. `bin/bevy-plugin.mjs` calls it with `process.argv.slice(2)` and installs SIGINT/SIGTERM forwarding to the child.

Do not:

- auto-run `cargo install`;
- buffer stdio;
- inspect JSON-RPC;
- rename upstream tools;
- add MCP SDK server dependencies.

Run `npm test`; expected PASS.

- [ ] **Step 4: Add plugin metadata modeled on `godot-mcp`**

Root `mcp.json` and `plugins/bevy-plugin/.mcp.json` both point to:

```json
{
  "mcpServers": {
    "bevy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cwchanap/bevy-plugin@0.1.0"]
    }
  }
}
```

Create root Agent Plugins `plugin.json`, Codex plugin metadata, Claude plugin metadata, and the two marketplace files using the existing Godot repository's structure with Bevy-specific names/descriptions.

- [ ] **Step 5: Commit Task 2**

```bash
git add package.json package-lock.json bin src test plugin.json mcp.json plugins .agents .claude-plugin
git commit -m "feat: package Bevy MCP agent launcher"
```

---

### Task 3: Prove the wrapper against the real upstream MCP and real Bevy fixture

**Files:**
- Create: `scripts/integration.mjs`
- Create: `scripts/smoke-packed-cli.mjs`
- Modify: `package.json` only if the installed client package requires an exact script/import adjustment

**Interfaces:**
- Uses `Client` from `@modelcontextprotocol/client`.
- Uses `StdioClientTransport` from `@modelcontextprotocol/client/stdio`.
- Starts `bin/bevy-plugin.mjs`, which in turn starts the real `bevy_brp_mcp` binary.

- [ ] **Step 1: Write the packed launcher smoke**

`scripts/smoke-packed-cli.mjs` should:

1. run `npm pack --json`;
2. install the produced tarball into a temporary directory;
3. start that package's `bevy-plugin` binary with `BEVY_BRP_MCP_BIN` pointing to a tiny fake executable that speaks no MCP but records argv/stdio lifecycle;
4. verify the packed binary delegates to the override and exits with the fake's exit code;
5. remove the temp directory.

This smoke validates npm packaging without requiring Cargo compilation.

Run:

```bash
npm run smoke:packed
```

Expected: PASS.

- [ ] **Step 2: Implement the real MCP integration client**

Use the v2 imports:

```js
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

Construct:

```js
const client = new Client({
  name: 'bevy-plugin-integration',
  version: '1.0.0',
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['bin/bevy-plugin.mjs'],
  cwd: repoRoot,
  stderr: 'inherit',
});

await client.connect(transport);
```

`connect()` performs the real initialize handshake.

- [ ] **Step 3: Exercise the upstream generic tool surface instead of mocks**

The integration must call `client.listTools()` and assert at minimum:

```text
brp_list_bevy
brp_launch
world_query
brp_type_guide
world_get_components_watch
brp_list_agent_tools
brp_execute
brp_extras_screenshot
brp_extras_get_diagnostics
```

Then:

1. call `brp_list_bevy` with the repository root and locate `bevy-mcp-fixture`;
2. call `brp_launch` for that fixture at port 15702;
3. use `world_query` against the reflected fixture component;
4. call `brp_list_agent_tools` and assert `bevy_mcp_world_stats` and `bevy_mcp_time_control` are present with parameter/result schemas;
5. `brp_execute` `bevy_mcp/world_stats` with `{ "limit": 1 }` and assert one component row plus `truncated: true` when applicable;
6. `brp_execute` time control through pause, set-scale 2.0, and resume, asserting returned state each time;
7. call `brp_extras_get_diagnostics`;
8. call `brp_extras_screenshot` to a temporary PNG path and assert the file is non-empty (upstream owns PNG validity);
9. call the upstream shutdown tool and verify the launched process exits.

Always close the MCP client in `finally`.

- [ ] **Step 4: Run the real journey locally/CI-style**

Prerequisite:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

Linux:

```bash
xvfb-run -a npm run test:integration
```

macOS/Windows with a normal display:

```bash
npm run test:integration
```

Expected: full MCP initialize -> upstream launch -> live BRP -> custom agent methods -> extras -> shutdown journey PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts package.json package-lock.json
git commit -m "test: cover real Bevy MCP integration"
```

---

### Task 4: Finish README, CI, release publication, and final scope verification

**Files:**
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`
- Modify metadata only if final version synchronization requires it

**Interfaces:**
- Documents the two installation pieces clearly: upstream Cargo MCP + this bridge/plugin wrapper.
- Publishes npm package on GitHub Release/manual trigger.
- Keeps the Rust bridge on Git only.

- [ ] **Step 1: Write README setup around reuse, not replacement**

README Quick Start must include:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

Project dependency:

```bash
cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
```

App integration:

```rust
.add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
```

Also document:

- Bevy `png` feature requirement for screenshots;
- reflection + `app.register_type::<T>()` requirement for generic game-owned ECS inspection;
- standard upstream tools already provide launch/logs/query/mutation/watch/type-guide/screenshot/input/diagnostics;
- custom `world_stats` / `time_control` are discovered via `brp_list_agent_tools` and invoked via `brp_execute`;
- `BEVY_BRP_MCP_BIN` override;
- no standalone `bevy_ecs` support in v1;
- Codex/Claude/Agent Plugins install commands modeled after the Godot plugin marketplace flow.

- [ ] **Step 2: Add CI gates**

`.github/workflows/ci.yml` jobs:

**Rust:**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

**Node/package:**

```bash
npm ci
npm test
npm run smoke:packed
```

**Real integration (Ubuntu):**

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
xvfb-run -a npm run test:integration
```

Cache Cargo registry/git/target where useful, but do not add a custom build system.

- [ ] **Step 3: Add npm release publication**

Mirror `godot-mcp`:

- trigger on published GitHub Release;
- allow explicit `workflow_dispatch` publish flag;
- run all normal package/Rust gates before publish;
- setup Node with `registry-url: https://registry.npmjs.org`;
- `npm publish` using `NPM_TOKEN`.

Do not publish `bevy-mcp-bridge` to crates.io in this task.

- [ ] **Step 4: Run final verification**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm ci
npm test
npm run smoke:packed
xvfb-run -a npm run test:integration
```

Expected: all PASS.

Final scope scans:

```bash
rg "RuntimeClient|runtimeKind|query_entities|capture_screenshot|bevy_mcp_limit|EcsBridge" \
  bin src test crates fixtures scripts package.json
```

Expected: no local reimplementation of those removed concepts. `EcsBridge` may appear only in documentation, not production code.

Game-specific scan:

```bash
rg -i "scorpius|caelum|battle_snapshot|transport_demand" \
  bin src test crates fixtures scripts package.json README.md
```

Expected: no production/game-specific API.

Review the branch diff:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Confirm implementation remains on PR #1.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md .github plugin.json mcp.json plugins .agents .claude-plugin
git commit -m "docs: finalize Bevy MCP distribution"
```

## Completion criteria

PR #1 is ready to leave draft only when:

- upstream `bevy_brp_mcp` is the sole general MCP server;
- the bridge registers/publishes exactly two generic methods;
- `world_stats` is bounded and deterministic;
- time control validates scale before mutating `Time<Virtual>`;
- the full-app fixture exists from the first implementation task;
- the npm binary only delegates stdio to upstream and fails clearly when upstream is missing;
- the real MCP client integration passes through the wrapper into upstream and a real Bevy app;
- Agent Plugins/Codex/Claude metadata uses the same npm launcher;
- npm release publishing is wired;
- no game-specific, standalone-ECS, BRP-client, or duplicate tool implementation has crept back in.