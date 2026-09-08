# CLAUDE.md

This file provides repository guidance for agentic development.

## Active architecture direction

This repository is migrating from a thin launcher around the external `bevy_brp_mcp` executable to a **fully repository-owned TypeScript MCP server**.

The approved design and implementation plan are:

- `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md`
- `docs/superpowers/plans/2026-09-07-owned-bevy-mcp-server.md`

Implementation continues on PR #3 / branch `agent/owned-bevy-mcp-server-plan`. Do not create a second PR for this migration.

The old September 3 architecture that forbade a local MCP server/BRP client/Cargo/process layer is superseded.

## Migration target

`@cwchanap/bevy-plugin` becomes the actual MCP stdio server and owns the complete **47-tool default** Bevy MCP surface.

Use:

- `@modelcontextprotocol/server` 2.x for MCP framing/stdio;
- the existing TypeScript 5.x line unless the SDK requires a minimum 5.x bump;
- one local BRP HTTP client supporting instant JSON-RPC and native streaming watch requests;
- Cargo metadata + JSON compiler artifacts;
- referenced in-memory child-process tracking;
- one shared `LogStore` for app/watch filenames and paths;
- full local type-guide behavior and explicit composites.

The final merged code must not install, spawn, invoke, or fall back to `bevy_brp_mcp`.

## Temporary migration oracle

Do **not** delete the current `src/index.ts` / `src/launcher.ts` at the start of implementation. They remain temporarily only as a test oracle while the owned server is built through `src/owned-index.ts`.

Task 0 captures the pinned 0.22.3 `tools/list` contract into `contracts/bevy-brp-mcp-0.22.3-tools.json`. That checked-in fixture includes the 47 tools' names, titles, descriptions, annotations, input schemas, and output schemas and is redistributed with `THIRD_PARTY_NOTICES.md`.

Before cutover, run the same fixture journey against both the existing upstream launcher and `build/owned-index.js`. Only after the differential gate passes should `src/index.ts` become the owned server and `src/launcher.ts` be deleted.

This oracle is migration-only, not a runtime fallback. Final CI removes the upstream install step.

## Tool contract rules

- Default parity is 47 tools. Do not add `brp_get_trace_log_path` or `brp_set_tracing_level`; they are non-default `mcp-debug` tools.
- Runtime registration uses the checked-in captured metadata through the MCP SDK raw JSON-Schema adapter instead of hand-transcribing dozens of Zod schemas.
- Preserve captured tool title/description/annotations/input/output schema. Only narrowly reviewed prose substitutions for retired upstream log filenames are allowed.
- `brp_execute` remains first-class but must never be another handler's fallback.
- All tools use the upstream-compatible response envelope: required `status`, `message`, `call_info`; optional `metadata`, `parameters`, `result`, `error_info`, `brp_extras_debug_info`. `result` is not required.
- The captured shared output schema must be registered for every tool.

## BRP and composites

- BRP host is localhost and default port is 15702.
- No retry or method cache.
- Reject unsafe parsed integer values rather than silently corrupting 64-bit entity/integer data.
- Entity-name discovery uses reflected `bevy_ecs::name::Name` and is live-smoke tested in the same task.
- Screenshot-by-name resolves through the local name composite, not `brp_execute`.
- Watches consume Bevy's native `world.get_components+watch` / `world.list_components+watch` SSE stream. Do not implement polling or canonical-JSON snapshot diffing.

## Type-guide scope

`brp_type_guide` and `brp_all_type_guides` require **full default parity**, not a generic `registry.schema` pretty-printer.

The owned implementation must preserve:

- registry presence and fully qualified type names;
- schema/type-kind information;
- spawn/insert examples;
- mutation paths across structs/tuples/enums/containers/nested types;
- curated Bevy type example knowledge;
- `agent_guidance`, including Entity warnings;
- per-type error behavior;
- the port-only `brp_all_type_guides` public contract.

Substantially translated upstream algorithms/constants need source comments and MIT attribution through `THIRD_PARTY_NOTICES.md`. Validate representative outputs against upstream goldens before cutover.

## Logs and process lifecycle

`LogStore` alone owns `<tmp>/bevy-mcp/{apps,watches}` and absolute paths.

Public log contracts remain:

```text
brp_list_logs   { app_name?, verbose? }
brp_read_log    { filename, keyword?, tail_lines? }
brp_delete_logs { app_name?, older_than_seconds? }
```

Callers never provide absolute paths or BRP ports to log tools.

Spawned Bevy children remain referenced; do not call `unref()`. Cleanup order is:

```text
watches.stopAll()
-> processes.shutdownAll()
-> server.close()
```

Cargo builds always rely on Cargo incremental compilation. Do not port upstream freshness logic.

## App-side Rust bridge

Keep `crates/bevy-mcp-bridge` and `bevy_brp_extras` as the Bevy application-side integration. Do not reimplement extras in the MCP migration.

`BevyMcpPlugin` continues to add `BrpExtrasPlugin`, register `bevy_mcp/world_stats` and `bevy_mcp/time_control`, and publish their agent metadata. They remain discoverable through `brp_list_agent_tools` and callable through `brp_execute`; they are not extra top-level MCP tools.

Existing Rust invariants remain unchanged:

- `world_stats`: default limit 50, max 500, reject 0, deterministic ordering, `returned` + `truncated`;
- `time_control`: validate finite positive scale before mutating `Time<Virtual>`.

## Review and delivery rules

- One migration PR; tasks are commit/review checkpoints only.
- Review each task commit before the next task.
- No database, daemon, DI framework, generic tool-codegen framework, remote-host support, WASM relay, or game-specific commands.
- Use one upstream-independence test at final cleanup; do not add duplicate grep scripts/CI mechanisms.
- Keep `brp_all_type_guides` despite response size because it is part of the default parity contract.

## Current transitional state

Until the final cutover task, the package bin still points to the legacy launcher. That is intentional so the implementation has a differential oracle and CI remains meaningful while the owned server is incomplete.

README/current runtime prerequisites therefore remain transitional until the final cleanup task. Do not deepen them or treat them as the desired architecture.

## Commands

Current baseline commands:

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

Follow the September 7 implementation plan for the temporary owned-server entrypoint, contract capture, differential integration, and final no-upstream gates.

## Distribution

Keep all client entrypoints resolving to the same npm package:

- root `plugin.json` + `mcp.json`;
- `plugins/bevy-plugin/` Codex/Claude manifests;
- `.claude-plugin/marketplace.json`;
- `.agents/plugins/marketplace.json`.

Do not create client-specific MCP implementations.

`crates/bevy-mcp-bridge` remains `publish = false`; consumers use the git dependency. Final npm contents include the owned `build/**`, captured `contracts/**`, `THIRD_PARTY_NOTICES.md`, `plugin.json`, and `mcp.json`, but never an upstream executable.