# CLAUDE.md

This file provides repository guidance for agentic development.

## Active architecture direction

This repository is migrating from a thin launcher around the external `bevy_brp_mcp` executable to a **fully repository-owned TypeScript MCP server**.

The approved design and implementation plan are:

- `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`
- `docs/superpowers/plans/2026-09-07-owned-bevy-mcp-server.md`

Implementation continues on the same branch/PR as those planning documents. Do not create a second PR for the migration.

The old September 3 design deliberately forbade a local MCP server, BRP client, Cargo discovery, process manager, and ECS tool layer. That decision is superseded. Do **not** use the old design as an implementation constraint.

This branch is still planning/guidance-only at the moment: `src/index.ts`/`src/launcher.ts`, current CI, and current runtime behavior remain upstream-delegating until Task 1 begins. The guidance is changed now so the implementation agent does not follow the superseded architecture lock.

## Migration target

`@cwchanap/bevy-plugin` becomes the actual MCP stdio server. It will own the complete **47-tool default** Bevy MCP surface locally using:

- `@modelcontextprotocol/server` 2.x for MCP protocol/stdio;
- TypeScript 5.x and Zod 4;
- one local BRP JSON-RPC client over localhost HTTP;
- Cargo metadata/build artifact discovery;
- in-memory process tracking;
- one shared `LogStore` for app/watch paths;
- local polling watches;
- local type-guide transforms and composites.

The external `bevy_brp_mcp` executable must disappear as a runtime, build, install, subprocess, fallback, and packaging dependency.

`brp_execute` remains a first-class explicit tool but must never be used as a fallback for missing handlers.

## App-side Rust bridge

Keep `crates/bevy-mcp-bridge` and `bevy_brp_extras` as the Bevy application-side integration. Do not reimplement extras in this migration.

`BevyMcpPlugin` continues to:

- add `BrpExtrasPlugin`;
- register `bevy_mcp/world_stats`;
- register `bevy_mcp/time_control`;
- publish those methods through agent-tool metadata.

Those two application methods remain discoverable through `brp_list_agent_tools` and callable through `brp_execute`; they are not additional top-level MCP tools.

Behavioral invariants already pinned by Rust tests remain unchanged:

- `world_stats`: default limit 50, max 500, reject 0, deterministic ordering, `returned` + `truncated`;
- `time_control`: validate finite positive scale before mutating `Time<Virtual>`.

## Default parity boundary

The migration targets the default upstream catalog, not the optional `mcp-debug` feature. Therefore the owned catalog is 47 tools. Do not add `brp_get_trace_log_path` or `brp_set_tracing_level` in this PR.

The migration may consult pinned upstream commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b` as a behavioral/schema reference only. Never fetch or execute upstream at runtime or in CI.

After the schemas are transcribed, local Zod/JSON-schema snapshots become the maintained contract. Future Bevy/BRP updates are explicit schema/method-table audits.

## Important implementation rules

- One migration PR; review each task commit before the next task.
- Keep TypeScript on the current 5.x line unless the MCP SDK proves a higher minimum is required.
- Use one structured MCP result envelope: `{ message, result, metadata? }`.
- Entity-name lookup uses reflected type `bevy_ecs::name::Name`.
- `LogStore` alone creates app/watch log paths.
- Spawned Bevy child processes are tracked and are **not** `unref()`ed.
- Server cleanup order is watches -> tracked processes -> MCP server close.
- Cargo builds always run through Cargo and rely on incremental compilation; do not add custom freshness logic.
- No database, daemon, DI framework, generic tool-codegen framework, remote-host support, WASM relay, or game-specific commands.
- `brp_all_type_guides` stays in the default parity surface even though it can return a large payload.

## Current transitional state

Until Task 1 of the September 7 plan lands, `src/index.ts`/`src/launcher.ts` still represent the old upstream-delegating implementation. Treat them as code scheduled for deletion, not as the intended architecture.

Likewise, the old September 3 spec/plan and upstream-oriented README/CI instructions are transitional files scheduled for removal/rewrite by the migration plan.

## Commands

Current commands remain:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

npm ci
npm run typecheck
npm run build
npm test
npm run smoke:packed
npm run test:integration
```

As the migration lands, follow the September 7 implementation plan for added `check:no-upstream`, name-smoke integration, and owned-server E2E gates.

## Distribution

Keep all client entrypoints resolving to the same npm package:

- root `plugin.json` + `mcp.json`;
- `plugins/bevy-plugin/` Codex/Claude manifests;
- `.claude-plugin/marketplace.json`;
- `.agents/plugins/marketplace.json`.

Do not create client-specific MCP implementations.

`crates/bevy-mcp-bridge` remains `publish = false`; consumers use the git dependency. npm publication remains gated by Rust, Node, and real integration CI.
