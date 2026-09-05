# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is (and deliberately is not)

This repo does **not** implement an MCP server. Upstream `bevy_brp_mcp` 0.22.3 (installed via
`cargo install`, not vendored here) owns the entire generic tool surface: target discovery, launch,
logs, ECS query/mutate/watch, type guides, `rpc.discover`, raw BRP execution, and the
`bevy_brp_extras` passthroughs (screenshot, input, diagnostics, shutdown).

This repo owns exactly two things:

1. **`crates/bevy-mcp-bridge`** — a Bevy plugin (`BevyMcpPlugin`) that registers two extra BRP
   methods into the host app's own BRP endpoint.
2. **The npm package `@cwchanap/bevy-plugin`** — a thin TypeScript stdio passthrough
   (`src/launcher.ts` + `src/index.ts`, compiled to `build/`) that spawns the upstream binary, plus
   the Codex/Claude/Agent-Plugins manifests that point every client at that one binary.

When adding functionality, first check whether upstream already provides it. Do not reimplement a
BRP client, Cargo discovery, process manager, ECS tool layer, screenshot handling, or a local error
taxonomy — those were explicitly designed out (see `docs/superpowers/specs/`). The launcher must
never parse or proxy MCP messages, and must never run `cargo install` on the user's behalf.

## Commands

```bash
cargo fmt --all -- --check
cargo test --workspace                       # bridge unit tests + fixture build
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p bevy-mcp-bridge <test_name>    # single Rust test

npm ci
npm run typecheck                            # strict TypeScript check
npm run build                                # compile src/ -> build/
npm test                                     # compile + run launcher tests
npm run smoke:packed                         # npm pack -> install -> run bin against a fake upstream
npm run test:integration                     # build + full journey; needs a display
```

`npm run test:integration` is the only test that exercises the real path end to end. It requires
`bevy_brp_mcp` on PATH (or `BEVY_BRP_MCP_BIN`) and a display — on Linux/CI use
`xvfb-run -a npm run test:integration`. It builds and launches `fixtures/full-app` on port 15702.

## Architecture

```
agent client --stdio--> build/index.js --spawn--> bevy_brp_mcp (upstream)
                                                   |
                                               BRP :15702
                                                   v
                                    your Bevy app + BevyMcpPlugin
                                       (BrpExtrasPlugin + 2 methods)
```

`BevyMcpPlugin` (`crates/bevy-mcp-bridge/src/lib.rs`) adds `BrpExtrasPlugin`, registers the two
systems, inserts them into the `RemoteMethods` resource as `RemoteMethodSystemId::Instant`, then
publishes typed metadata via `register_agent_tool` with params/result JSON schemas.

**The two methods are not separate MCP tools.** Agents discover them with `brp_list_agent_tools` and
invoke them via `brp_execute` with `method: "bevy_mcp/world_stats"` / `"bevy_mcp/time_control"`.
Anything that looks like a new tool in this repo goes through that same route.

`methods.rs` separates pure logic from BRP plumbing on purpose: `collect_world_stats(&World, limit)`
and `apply_time_control(&mut Time<Virtual>, params)` return `Result<_, String>` and are unit-tested
directly in `crates/bevy-mcp-bridge/tests/methods.rs`; the `world_stats` / `time_control` system
wrappers only deserialize, delegate, and map errors to `BrpError`. Keep new logic on the pure side.

Behavioral invariants the tests pin down:
- `world_stats` is bounded — default limit 50, max 500, rejects 0; results carry `returned` and
  `truncated`, sorted by count desc then name asc.
- `world_stats` counts the **entity** domain only: empty archetypes and the resource archetype
  (identified by the `IsResource` component id) are filtered out, so `archetypes` is smaller than
  `World::archetypes().len()`.
- `time_control` validates scale (finite, > 0) *before* mutating `Time<Virtual>`.

## Version pins (change these together)

- **`bevy_brp_mcp` / `bevy_brp_extras` 0.22.3** appears in `crates/bevy-mcp-bridge/Cargo.toml`,
  `PREREQUISITE_COMMAND` in `src/launcher.ts`, the assertion in `test/launcher.test.ts`, the CI
  `cargo install` step, and the README. The upstream and extras versions must match.
- **Bevy 0.19.1** — the bridge depends on focused subcrates (`bevy_app`, `bevy_ecs`, `bevy_remote`,
  `bevy_time`), never the umbrella `bevy` crate. The fixture uses the umbrella crate with `png`.
- **npm package version** is duplicated in `package.json`, `plugin.json`, `mcp.json`,
  `plugins/bevy-plugin/.mcp.json`, `plugins/bevy-plugin/.claude-plugin/plugin.json`, and
  `plugins/bevy-plugin/.codex-plugin/plugin.json` (the latter two also pin `@0.1.0` in the npx args).
  A release bump must touch all of them.

## Distribution layout

- `plugins/bevy-plugin/` — Claude Code and Codex plugin manifests, both delegating to `./.mcp.json`.
- `plugin.json` + `mcp.json` at the repo root — the portable Agent Plugins 1.0 package (this is the
  Pi path, via `pi-mcp-adapter` + `pi-agent-plugins`).
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` — marketplace entries
  pointing at `./plugins/bevy-plugin`.

All entrypoints resolve to the same npm package; keep them consistent rather than adding a
client-specific code path.

## Publishing

`.github/workflows/ci.yml` gates `npm publish --access public` behind the rust, node, and
integration jobs, triggered by a GitHub release or a `workflow_dispatch` with
`trigger_publish=true`. `crates/bevy-mcp-bridge` is `publish = false` — consumers add it by git URL.
