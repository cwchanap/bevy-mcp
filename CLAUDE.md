# CLAUDE.md

This file provides repository guidance for agentic development.

## Architecture

The npm package `@cwchanap/bevy-plugin` is a **fully repository-owned TypeScript MCP stdio server** (`src/index.ts`, bin `build/index.js`) that owns the complete **47-tool default** Bevy MCP surface. There is no external MCP server executable: the code must never install, spawn, invoke, or fall back to the upstream `bevy_brp_mcp` binary. `test/upstream-independence.test.ts` enforces this over the active surfaces (`src`, `scripts`, `.github`, manifests, `plugins/`, `README.md`, `CLAUDE.md`) — one test only; do not add duplicate scanner scripts or CI commands.

Stack:

- `@modelcontextprotocol/server` 2.x for MCP framing/stdio;
- one local BRP HTTP client supporting instant JSON-RPC and native streaming watch requests;
- Cargo metadata + JSON compiler artifacts;
- referenced in-memory child-process tracking;
- one shared `LogStore` for app/watch filenames and paths;
- full local type-guide behavior and explicit composites.

The 47-tool wire contract is captured from upstream `bevy_brp_mcp` 0.22.3 (commit `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`) into `contracts/bevy-brp-mcp-0.22.3-tools.json` — names, titles, descriptions, annotations, input schemas, and output schemas — redistributed with `THIRD_PARTY_NOTICES.md`.

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
- Entity-name discovery uses reflected `bevy_ecs::name::Name` and is covered by the live integration journey.
- Screenshot-by-name resolves through the local name composite, not `brp_execute`.
- Watches consume Bevy's native `world.get_components+watch` / `world.list_components+watch` SSE stream. Do not implement polling or canonical-JSON snapshot diffing.

## Type-guide scope

`brp_type_guide` and `brp_all_type_guides` provide **full default parity**, not a generic `registry.schema` pretty-printer.

The implementation preserves:

- registry presence and fully qualified type names;
- schema/type-kind information;
- spawn/insert examples;
- mutation paths across structs/tuples/enums/containers/nested types;
- curated Bevy type example knowledge;
- `agent_guidance`, including Entity warnings;
- per-type error behavior;
- the port-only `brp_all_type_guides` public contract.

Substantially translated upstream algorithms/constants carry source comments and MIT attribution through `THIRD_PARTY_NOTICES.md`. Representative outputs are validated against upstream goldens by the parity tests.

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

Keep `crates/bevy-mcp-bridge` and `bevy_brp_extras` as the Bevy application-side integration. Do not reimplement extras in the MCP server.

`BevyMcpPlugin` adds `BrpExtrasPlugin`, registers `bevy_mcp/world_stats` and `bevy_mcp/time_control`, and publishes their agent metadata. They remain discoverable through `brp_list_agent_tools` and callable through `brp_execute`; they are not extra top-level MCP tools.

Existing Rust invariants remain unchanged:

- `world_stats`: default limit 50, max 500, reject 0, deterministic ordering, `returned` + `truncated`;
- `time_control`: validate finite positive scale before mutating `Time<Virtual>`.

## Repository rules

- No database, daemon, DI framework, generic tool-codegen framework, remote-host support, WASM relay, or game-specific commands.
- Keep `brp_all_type_guides` despite response size because it is part of the default parity contract.

## Commands

Baseline gates:

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

The integration journey runs only the owned server (`build/index.js`) against the real Bevy fixture; build the fixture first with `cargo build -p bevy-mcp-fixture` (CI wraps the run in `xvfb-run`).

## Distribution

Keep all client entrypoints resolving to the same npm package:

- root `plugin.json` + `mcp.json`;
- `plugins/bevy-plugin/` Codex/Claude manifests;
- `.claude-plugin/marketplace.json`;
- `.agents/plugins/marketplace.json`.

Do not create client-specific MCP implementations.

`crates/bevy-mcp-bridge` remains `publish = false`; consumers use the git dependency. npm contents are the owned `build/**`, captured `contracts/**`, `THIRD_PARTY_NOTICES.md`, `plugin.json`, and `mcp.json` — never an upstream executable.
