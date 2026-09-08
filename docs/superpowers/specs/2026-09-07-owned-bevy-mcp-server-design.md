# Owned Bevy MCP Server Design

## Status

Approved on September 7, 2026 and revised after two design reviews on the same date. This design supersedes `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`.

The architectural decision remains unchanged: this repository will own the complete **default** Bevy MCP server instead of launching the external `bevy_brp_mcp` executable. The second review found that the parity mechanism was too weak, not that the architecture was wrong. This revision makes parity machine-checkable and gives the type-guide subsystem the scope it actually requires.

The final merged product must have no runtime, build, install, subprocess, fallback, or CI dependency on the upstream MCP executable. During this one migration PR only, the existing launcher and pinned upstream 0.22.3 binary may remain temporarily as a **test oracle** until the owned server passes differential validation. They are deleted before the PR is complete.

## Review resolutions

The second review is incorporated as follows:

1. **Use a real parity oracle.** Capture the pinned upstream 0.22.3 `tools/list` response once and check it into `contracts/bevy-brp-mcp-0.22.3-tools.json`. The capture contains all 47 default tools with `name`, `title`, `description`, `annotations`, `inputSchema`, and `outputSchema`. It is static licensed reference data, not a live dependency.
2. **Preserve tool guidance, not only names.** Runtime registration uses the checked-in contract metadata, so titles, descriptions, annotations, and schemas cannot silently disappear. A tiny reviewed override map may update obsolete log filename wording from `bevy_brp_mcp_*` to the repository-owned naming; all other contract drift is rejected.
3. **Do not hand-transcribe 47 schemas.** Use the MCP SDK's raw JSON-Schema adapter (`fromJsonSchema`) with the checked-in contract fixture. This removes dozens of error-prone Zod transcriptions while keeping validation local and owned.
4. **Match the real output envelope.** Every tool advertises and returns the upstream-compatible `ToolCallJsonResponse`: required `status`, `message`, and `call_info`; optional `metadata`, `parameters`, `result`, `error_info`, and `brp_extras_debug_info`. `result` is optional.
5. **Treat type guides as a real subsystem.** Full default parity includes spawn/insert examples, mutation paths, agent guidance, schema info, registry presence, errors, and the curated Bevy type knowledge used to construct valid values. This work gets dedicated tasks and golden differential tests rather than one generic schema transform step.
6. **Keep the old launcher only until cutover.** `src/index.ts`/`src/launcher.ts` stay as the upstream oracle while the owned server is developed through a temporary `owned-index` entrypoint. Before final cleanup, the same integration journey runs against both servers and compares normalized results. Then the launcher and upstream CI install step are removed.
7. **Use the BRP watch stream.** `world.get_components+watch` and `world.list_components+watch` use their native streaming HTTP/SSE response. No polling loop or canonical-JSON differ is added.
8. **Match log tool contracts exactly.** The public boundary remains filename/app-filter based: `brp_read_log{filename, keyword, tail_lines}`, `brp_list_logs{app_name, verbose}`, and `brp_delete_logs{app_name, older_than_seconds}`. Absolute paths are internal to `LogStore` only.
9. **Keep one independence guard.** A single existing-suite test scans active runtime/build/config paths for executable/install dependency patterns. Final integration runs after the upstream install step has been removed, providing the behavioral proof.
10. **Fail on unsafe JSON integers.** The BRP client rejects parsed integer values outside JavaScript's safe-integer range instead of silently corrupting entity IDs or other integer data.

The previous review resolutions also remain in force: the default catalog is 47 tools (the two `mcp-debug` trace tools are excluded), reflected entity names use `bevy_ecs::name::Name`, spawned children remain referenced and are cleaned up, `LogStore` is the sole path allocator, TypeScript stays on the current 5.x line unless the MCP SDK requires a minimum bump, Cargo freshness logic is not ported, and `brp_all_type_guides` retains its upstream port-only public contract.

## Goal

Ship `@cwchanap/bevy-plugin` as a self-contained TypeScript MCP stdio server for Bevy development. A developer with Node.js, Rust, and a Bevy project can install the plugin and use the complete default Bevy MCP surface without separately installing `bevy_brp_mcp`.

The existing Rust `bevy-mcp-bridge` remains the application-side integration. It composes `bevy_brp_extras` and registers `bevy_mcp/world_stats` and `bevy_mcp/time_control`. `bevy_brp_extras` is an app-side BRP provider, not the MCP server dependency being removed.

## Product principles

- One implementation PR for the migration.
- Own every tool in the 47-tool default catalog; `brp_execute` is a public tool, never a fallback implementation for another tool.
- Preserve the public MCP contract where doing so does not encode the old executable's identity.
- Prefer static contract data and small Node modules over hand-written schema duplication, macro frameworks, databases, daemons, or custom Cargo build intelligence.
- Generic Bevy developer tooling only; no game-specific commands.
- No backward-compatibility layer beyond the explicit upstream parity target for this migration.

## Compatibility baseline

- Node.js: `>=20`
- MCP server SDK: `@modelcontextprotocol/server` 2.x
- MCP integration client: `@modelcontextprotocol/client` 2.x
- TypeScript: existing 5.x line (`^5.3.3` today), raised only if the SDK actually requires it
- Bevy: 0.19.x
- `bevy_brp_extras`: 0.22.3
- Rust: `>=1.95`, edition 2024
- Default BRP port: 15702
- Native macOS/Linux/Windows debugging

No direct schema-library dependency is required for tool registration: the server SDK can adapt the captured raw JSON Schemas. Internal TypeScript types remain ordinary interfaces and narrow parsing helpers.

## Parity source and licensed contract fixture

The migration reference is:

```text
natepiano/bevy_brp
commit 85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b
bevy_brp_mcp 0.22.3
```

At the start of implementation, the existing launcher connects to that pinned default server once and captures its `tools/list` result into:

```text
contracts/bevy-brp-mcp-0.22.3-tools.json
```

Each entry stores exactly the public contract fields needed by clients:

```ts
interface CapturedToolContract {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
```

The repository also adds `THIRD_PARTY_NOTICES.md` identifying the source commit/package and reproducing the applicable MIT notice for copied descriptions/schema metadata and any translated type-guide logic.

This fixture is immutable migration evidence. CI never regenerates it and the final product never invokes upstream to read it. It is checked-in data owned by this repository after capture.

### Runtime use of the contract

`ToolContractCatalog` loads the checked-in fixture and `registerOwnedTool()` registers the local handler with the captured:

- title;
- description;
- annotations;
- input schema via `fromJsonSchema`;
- output schema via `fromJsonSchema`.

This makes the captured public metadata the runtime contract as well as the parity oracle, avoiding a second hand-maintained schema representation.

A small `CONTRACT_OVERRIDES` map may change only reviewed fields that necessarily refer to the retired implementation. Initial allowed differences are log-description text that names `bevy_brp_mcp_*` files. Name, input schema, output schema, and annotations have no general allowlist.

## Default 47-tool catalog

### World / ECS / resources / discovery

- `world_list_components`
- `world_get_components`
- `world_despawn_entity`
- `world_insert_components`
- `world_remove_components`
- `world_list_resources`
- `world_get_resources`
- `world_insert_resources`
- `world_remove_resources`
- `world_mutate_resources`
- `world_mutate_components`
- `rpc_discover`
- `world_query`
- `world_find_entities_by_name`
- `world_spawn_entity`
- `world_trigger_event`
- `registry_schema`
- `world_reparent_entities`

### Watches

- `world_get_components_watch`
- `world_list_components_watch`
- `brp_stop_watch`
- `brp_list_active_watches`

### Dynamic/application discovery

- `brp_execute`
- `brp_list_agent_tools`

### BRP extras

- `brp_extras_screenshot`
- `brp_extras_send_keys`
- `brp_extras_type_text`
- `brp_extras_set_window_title`
- `brp_extras_move_mouse`
- `brp_extras_send_mouse_button`
- `brp_extras_click_mouse`
- `brp_extras_double_click_mouse`
- `brp_extras_drag_mouse`
- `brp_extras_scroll_mouse`
- `brp_extras_pinch_gesture`
- `brp_extras_rotation_gesture`
- `brp_extras_double_tap_gesture`
- `brp_extras_get_diagnostics`

### Application/process/log lifecycle

- `brp_list_bevy`
- `brp_launch`
- `brp_shutdown`
- `brp_status`
- `brp_list_logs`
- `brp_read_log`
- `brp_delete_logs`

### Type intelligence

- `brp_type_guide`
- `brp_all_type_guides`

The optional upstream `mcp-debug` tools `brp_get_trace_log_path` and `brp_set_tracing_level` are not in the default catalog and are not implemented in this PR.

## Architecture

```text
Codex / Claude / Pi / MCP client
                  |
                  | stdio
                  v
       @cwchanap/bevy-plugin
       TypeScript MCP server
                  |
       +----------+-----------+
       |                      |
       v                      v
 Node runtime services    BRP HTTP client
 Cargo/process/log/watch   call + stream
                                |
                                v
                          Bevy application
                                |
                    +-----------+-----------+
                    |                       |
              BrpExtrasPlugin          BevyMcpPlugin
              screenshot/input/...     world_stats/time_control
```

### Ownership boundaries

**Tool contract catalog** owns checked-in names/titles/descriptions/annotations/input/output schemas and the tiny explicit override map.

**MCP server** owns stdio, local handler registration, response construction, and MCP error signaling.

**BRP client** owns localhost JSON-RPC HTTP calls, streaming requests, timeout/abort behavior, response decoding, BRP error normalization, and unsafe-integer rejection. It contains no tool-specific orchestration.

**Cargo runtime** owns `cargo metadata` target discovery and `cargo build --message-format=json-render-diagnostics` artifact resolution. It always invokes Cargo build and relies on Cargo incremental compilation.

**Process manager** owns tracked spawned-child lifecycle only. It never allocates paths and does not persist state.

**LogStore** owns `<tmp>/bevy-mcp/{apps,watches}`, filename allocation, filename-to-owned-path resolution, list/read/delete filtering, and containment.

**WatchManager** owns numeric watch IDs, one open streaming request per watch, stream cancellation, active-watch metadata, lifecycle cleanup, and writing received watch events to a `LogStore`-provided file.

**Type-guide subsystem** owns the full default type-intelligence behavior: registry/type-name resolution, type-kind/schema interpretation, spawn/insert examples, mutation paths, agent guidance, curated Bevy type knowledge, and all-types orchestration.

## MCP tool response contract

All 47 tools advertise the same captured output schema and return an upstream-compatible structured response:

```ts
type ResponseStatus = 'success' | 'error';

type CallInfo =
  | { mcp_tool: string }
  | { mcp_tool: string; brp_method: string };

interface ToolCallJsonResponse {
  status: ResponseStatus;
  message: string;
  call_info: CallInfo;
  metadata?: unknown;
  parameters?: unknown;
  result?: unknown;
  error_info?: unknown;
  brp_extras_debug_info?: unknown;
}
```

`status`, `message`, and `call_info` are always present. `result` is optional. A successful tool call can legitimately have metadata but no result. Errors use `status: 'error'`, `isError: true`, and place structured details in `metadata` and/or `error_info` as appropriate.

`parameters` preserves normalized public parameters for parity, omitting absent optional/null fields the same way the upstream response builder does. Direct BRP wrappers use a BRP-form `call_info`; local/composite tools use local call info unless they represent one fixed BRP method.

The MCP SDK registers the shared captured `outputSchema`, so invalid local `structuredContent` is caught during tests/server execution rather than by consumers.

## BRP transport

`BrpClient` uses native `fetch` against `http://127.0.0.1:<port>`.

### Instant calls

`call(method, params, options)` performs one JSON-RPC 2.0 POST with request IDs, timeout, caller abort forwarding, JSON decoding, HTTP/JSON-RPC error conversion, and no retry/method cache.

After JSON parsing, the client recursively rejects integer values for which `Number.isSafeInteger(value)` is false. This turns unsupported 64-bit integer responses into explicit errors instead of silently corrupting entity IDs or component data.

### Streaming calls

`stream(method, params, options)` performs the same request without an ordinary call timeout and returns a successfully established HTTP response/body plus an abort handle. It is used only by watch tools.

No remote-host support, alternate transport, reconnect loop, or generic proxy is included.

## Direct tools and composites

Most BRP passthroughs use one fixed-method helper. Contracts come from `ToolContractCatalog`; handler code only removes MCP-only routing fields such as `port`, calls the fixed method, and builds the standard response.

Explicit local/composite handlers are limited to behavior that actually needs orchestration:

- `world_find_entities_by_name`;
- `brp_execute` discovery validation;
- `brp_list_agent_tools` normalization/error metadata;
- `brp_extras_screenshot` exact-name resolution;
- watches;
- Cargo/application/process/log tools;
- type guides.

No handler calls the `brp_execute` handler as a shortcut.

## Reflected `Name`

Entity-name lookup queries:

```text
bevy_ecs::name::Name
```

It performs one standard `world.query` with the type in both `data.components` and `filter.with`, decodes the observed Bevy 0.19 Name wire value, filters case-sensitively with `exact | prefix | suffix | contains`, and sorts by entity ID.

The fixture gains `Name::new("FixturePrimary")` and a mutable `FixtureValue` in the same implementation task. A live smoke test must prove the actual BRP payload before screenshot-by-name is accepted.

## Native watch streams

`world_get_components_watch` and `world_list_components_watch` open the Bevy `+watch` streaming endpoint instead of polling snapshots.

Rules:

- IDs start at 1 and increase monotonically;
- `world_get_components_watch` requires at least one type;
- `LogStore` allocates the watch filename/path before connection;
- the watch is exposed as active only after the HTTP streaming response is successfully established;
- the parser accepts SSE `data: <json>` records split across arbitrary chunks/lines;
- JSON-RPC `result` values are appended as watch update records;
- stream error/end removes the watch from the active registry;
- `brp_stop_watch` aborts the stream;
- stopping an unknown watch is a tool error;
- all streams abort during server shutdown.

No polling interval, canonical JSON serializer, or change-diff logic exists.

## Cargo and process lifecycle

`brp_list_bevy` uses `cargo metadata --format-version 1 --no-deps` and deterministic target normalization.

`brp_launch` resolves app/example/package/path, validates consecutive ports, invokes Cargo build, parses the matching `compiler-artifact.executable`, asks `LogStore` for app log filenames, then spawns referenced child processes with `BRP_EXTRAS_PORT` set after user environment merging.

No custom freshness optimizer is ported.

Spawned children are not `unref()`ed. `brp_shutdown` first requests `brp_extras/shutdown`, waits a bounded interval, then terminates a tracked child still alive. Shared server cleanup is:

```text
WatchManager.stopAll()
-> ProcessManager.shutdownAll()
-> server.close()
```

## Log tools

Public contracts stay upstream-compatible:

```text
brp_list_logs   { app_name?, verbose? }
brp_read_log    { filename, keyword?, tail_lines? }
brp_delete_logs { app_name?, older_than_seconds? }
```

No log tool accepts an absolute path or BRP port.

Internally `LogStore` resolves filenames only under its owned root, rejects traversal, filters list/delete by app name and age, performs case-insensitive keyword filtering, and supports tail reads. Returned verbose metadata may include an absolute owned path, but callers never provide one.

MCP-internal observability uses stderr only.

## Full type-guide parity

`brp_type_guide` and `brp_all_type_guides` are not reduced to generic schema pretty-printing. The owned implementation reproduces the default upstream guide semantics, including:

- fully-qualified type naming and registry presence;
- type-kind/schema information;
- spawn/insert examples;
- mutation-path generation for structs, tuple structs, tuples, lists/arrays, maps/sets, enums and nested types;
- curated example values for Bevy-specific/special types where upstream uses type knowledge;
- `agent_guidance`, including Entity-specific warnings;
- per-type processing errors without turning one failed type into an all-types transport failure;
- complete `brp_all_type_guides` behavior with its existing port-only public parameters.

Translated algorithms/constants that are substantially derived from upstream carry source comments and are covered by `THIRD_PARTY_NOTICES.md`.

### Golden validation

Before deleting the oracle launcher, capture upstream type-guide outputs for representative live types from the fixture/app, including at minimum:

- `FixtureValue` struct;
- a fixture nested enum/struct type added for this purpose;
- Bevy `Transform`;
- a type containing `Entity`;
- a missing/unregistered type.

Store normalized golden responses under `test/contracts/type-guides/`. The owned implementation must match their semantic structure and guidance/mutation-path content. `brp_all_type_guides` is also compared for inclusion/count/failure semantics without committing an enormous all-types golden blob.

## Differential migration strategy

The existing launcher is not a fallback. It is retained temporarily as the reference executable while the owned server develops beside it.

During migration:

```text
build/index.js       -> existing upstream launcher
build/owned-index.js -> repository-owned MCP server
```

The integration harness accepts a server mode and can run the same fixture journey against either entrypoint. Before cutover it runs both and compares:

- exact `tools/list` metadata against the captured contract;
- deterministic structured response fields exactly;
- nondeterministic fields such as PID/path/timestamp/duration by normalized shape/meaning;
- representative type-guide outputs against captured goldens;
- watch event behavior through the native stream.

Only after the differential gate is green does the PR replace `src/index.ts` with the owned entrypoint and delete `src/launcher.ts`, its tests, and the upstream CI install step.

## Testing strategy

Testing remains one PR with task-level review checkpoints:

1. capture licensed upstream contract fixture and add parity oracle tests;
2. owned MCP server bootstrap beside the legacy launcher + full response envelope;
3. instant/streaming BRP transport;
4. direct world/resource registration driven by captured contracts;
5. live name discovery and agent tools;
6. type-guide core/schema/value construction;
7. type-guide mutation paths/knowledge/golden parity;
8. extras/screenshot composites;
9. `LogStore` + SSE watches;
10. Cargo discovery/build;
11. process/app/log lifecycle;
12. complete 47-tool registration + upstream-vs-owned differential cutover;
13. final no-upstream CI/docs/package cleanup.

## Final upstream-independence gate

The final repository keeps one unit test that scans active source/build/config surfaces for executable dependency patterns such as:

```text
cargo install bevy_brp_mcp
BEVY_BRP_MCP_BIN
spawn/command of bevy_brp_mcp
```

It intentionally does not reject historical/reference strings in design docs, `THIRD_PARTY_NOTICES.md`, or the static captured contract file. Final CI no longer installs upstream and the real owned-server integration must pass in that environment.

## Non-goals

- Reimplementing `bevy_brp_extras`.
- Publishing the Rust bridge to crates.io.
- Game-specific debug operations.
- Standalone `bevy_ecs::World` transport.
- WASM/browser relay.
- Remote-host discovery/authentication.
- Automatic consumer-project rewriting.
- Persistent process/watch state.
- Custom MCP framing.
- Custom Cargo freshness logic.
- Optional `mcp-debug` trace tools.

## Risks and mitigations

### Contract capture drift

The captured `tools/list` data is the migration source of truth for 0.22.3, so a bad capture would infect local registration. Mitigation: assert exactly 47 expected names, shared output schema, known method mappings, and source version during capture; never regenerate silently.

### Licensed copied material

Descriptions and translated type-guide logic are derived from upstream. Mitigation: preserve the MIT notice/source attribution in `THIRD_PARTY_NOTICES.md` and source comments where substantial code is translated.

### Type-guide scope

This is the largest logic port and easiest place to ship false parity. Mitigation: dedicated tasks, representative upstream goldens, live `Transform`/nested-enum coverage, and differential validation before cutover.

### Reflected type drift

A wrong Bevy type path/wire shape can make composites silently empty. Mitigation: same-task live fixture smoke for `bevy_ecs::name::Name`.

### Orphaned processes/streams

MCP exit could leave apps or watch connections alive. Mitigation: referenced children, abortable stream handles, idempotent ordered cleanup, and E2E process-exit assertions.

### JavaScript integer precision

BRP can carry integers larger than JavaScript's safe range. Mitigation: reject unsafe parsed integers centrally rather than returning corrupted IDs/data.

### Large all-type-guide response

`brp_all_type_guides` can be large, but changing its parameters would violate default parity. Mitigation: efficient shared registry/type processing and preserved upstream large-response behavior where required by the captured/differential contract.

## Definition of done

On a machine with Node, Rust, this repository, and the fixture Bevy app—but with no upstream MCP executable installed—the packed npm package must:

1. start directly as an MCP stdio server;
2. expose exactly the 47 captured default tools with owned descriptions/titles/annotations/input/output schemas, except explicitly reviewed implementation-name text overrides;
3. return responses matching the shared upstream-compatible output schema;
4. pass representative behavior tests for every tool family, including native watch streaming and full type-guide guidance/mutation paths;
5. complete the real fixture journey;
6. terminate its watches and tracked Bevy children on close; and
7. contain no executable/build/install/fallback dependency on `bevy_brp_mcp`.