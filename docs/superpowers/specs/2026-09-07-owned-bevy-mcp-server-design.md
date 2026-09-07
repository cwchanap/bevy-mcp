# Owned Bevy MCP Server Design

## Status

Approved on September 7, 2026 and revised after design review on the same date. This design supersedes `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md`.

The previous architecture deliberately delegated MCP behavior to the external `bevy_brp_mcp` executable. That decision is reversed: this repository will own the complete **default** MCP server behavior itself. Upstream source may be consulted as a pinned behavioral/schema reference while implementing parity, but it must not remain a runtime, build, install, subprocess, fallback, or packaging dependency.

This draft PR remains planning/guidance only: no MCP runtime behavior is changed by this document revision. `CLAUDE.md` and README are updated only to mark the approved migration and prevent future work from following the superseded architecture while implementation continues on the same PR.

## Review resolutions

The review was accepted with the following resolutions:

1. **Rewrite repository guidance.** `CLAUDE.md`/`AGENTS.md` currently forbid exactly this architecture. The planning branch updates that guidance before implementation begins, and the final migration task verifies it again.
2. **Fix reflected Bevy `Name`.** Entity-name discovery must query `bevy_ecs::name::Name`, not `bevy_core::name::Name`. The live fixture gains a `Name` in the same implementation task as name discovery so mocks cannot hide a wrong reflected type path or JSON shape.
3. **Pin one MCP result envelope.** Every tool returns structured content shaped as `{ message, result, metadata? }`; the existing integration journey already depends on that contract.
4. **Target 47 default tools, not 49.** `brp_get_trace_log_path` and `brp_set_tracing_level` are behind upstream's non-default `mcp-debug` feature. They are not part of the default parity target and are removed together with the proposed `TraceLogger`.
5. **Own process shutdown.** Spawned Bevy processes remain tracked and referenced. MCP shutdown stops watches, gracefully shuts down or terminates tracked Bevy processes, then closes the server. No `unref()` default.
6. **One path owner.** `LogStore` creates every app/watch log path. `WatchManager` and `ProcessManager` only write to paths supplied by `LogStore`.
7. **Keep TypeScript 5.x.** The server migration does not include a compiler-major upgrade. Add the MCP server SDK and Zod only; keep the current TypeScript 5.x line unless compilation proves a minimum-version bump is required.
8. **Split implementation review boundaries, not PRs.** Cargo discovery/build and process/log ownership are separate implementation tasks and review checkpoints while remaining on the same branch/PR.
9. **Expand independence cleanup.** CI's old `/tmp/bevy_brp_mcp_*.log` diagnostics, README, `CLAUDE.md`, and the `AGENTS.md` symlink target are part of the migration audit.
10. **Snapshot the local contract.** The pinned upstream commit defines the migration input; local Zod/JSON-schema snapshots become the maintained contract after transcription.

One review suggestion is intentionally **not** adopted: `brp_all_type_guides` is not dropped or given a new limit parameter because it is part of the default upstream tool surface and the user explicitly requested a complete rebuild. Its potentially large response is an accepted parity cost for this PR and is called out under Risks.

## Goal

Ship `@cwchanap/bevy-plugin` as a self-contained TypeScript MCP stdio server for Bevy development. A user with Node.js, Rust, and a Bevy project should be able to install the agent plugin and use the full default Bevy MCP toolset without separately installing `bevy_brp_mcp`.

The existing Rust `bevy-mcp-bridge` remains the application-side integration layer. It composes `bevy_brp_extras` and registers the repository-owned `bevy_mcp/world_stats` and `bevy_mcp/time_control` BRP methods. `bevy_brp_extras` is not the upstream MCP server being removed; it remains an app-side BRP capability provider.

## Product principles

- One implementation PR for the entire server rebuild.
- Own every tool in the default upstream MCP catalog; no tool may use `brp_execute` as a fallback for a missing implementation.
- `brp_execute` remains first-class because raw discovered BRP execution is itself part of the supported surface.
- Preserve current default tool names and parameter intent as the migration parity contract; internal source layout may change freely.
- Prefer small Node/TypeScript modules over porting Rust macros, registries, build-freshness logic, or other upstream implementation machinery.
- Keep generic Bevy functionality only; no game-specific commands.
- No backward-compatibility layer is required.
- No persistence database, daemon, dependency-injection framework, plugin framework, or generic schema code generator.

## Compatibility baseline

- Node.js: `>=20`
- MCP TypeScript SDK: `@modelcontextprotocol/server` 2.x
- MCP integration client: `@modelcontextprotocol/client` 2.x
- Schema library: Zod 4
- TypeScript: existing 5.x line (`^5.3.3` today), raised only if the server SDK actually requires it
- Bevy: 0.19.x
- `bevy_brp_extras`: 0.22.3
- Rust: `>=1.95`, edition 2024
- Default BRP port: 15702
- Native macOS/Linux/Windows debugging

## Parity source

Implementation may consult upstream `natepiano/bevy_brp` commit:

```text
85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b
```

This commit is a migration reference only. It is not fetched, built, linked, invoked, vendored, or packaged by this repository.

The upstream `mcp-debug` feature has no default enablement, so its two trace-only tools are outside the default catalog. The owned default catalog contains **47 tools**.

## Default 47-tool catalog

### World / ECS / resource / discovery

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

## Architecture

```text
Codex / Claude Code / Pi / MCP client
                  |
                  | stdio
                  v
       @cwchanap/bevy-plugin
       TypeScript MCP server
                  |
       +----------+-----------+
       |                      |
       v                      v
 Node runtime services    BRP JSON-RPC client
 Cargo/process/log/watch        |
                                | localhost HTTP
                                v
                          Bevy application
                                |
                    +-----------+-----------+
                    |                       |
              BrpExtrasPlugin          BevyMcpPlugin
              screenshot/input/...     world_stats/time_control
```

### Ownership boundaries

**MCP server owns:** MCP stdio, tool registration/schemas, tool result envelopes, orchestration, annotations, and error conversion.

**BRP client owns:** one JSON-RPC HTTP request, timeout/abort handling, response decoding, and BRP error normalization. It has no tool knowledge.

**Cargo runtime owns:** `cargo metadata` target discovery and `cargo build --message-format=json-render-diagnostics` artifact resolution. It always invokes Cargo build and relies on Cargo incremental compilation.

**Process manager owns:** live spawned-child state and lifecycle only. It does not create log paths and does not persist state.

**LogStore owns:** the complete `<tmp>/bevy-mcp/{apps,watches}` path policy, safe file creation, list/read/delete, filename sanitization, and containment checks.

**WatchManager owns:** monotonic watch IDs, polling, change detection, cancellation, and writing events to a `LogStore`-provided path. Watches are in-memory only.

**Type-guide module owns:** pure transformation from live Bevy registry data into the public guide format. No copied upstream prose framework.

## MCP result contract

All handlers use one helper and one structured-content envelope:

```ts
export interface ToolEnvelope<T = unknown, M extends Record<string, unknown> = Record<string, unknown>> {
  message: string;
  result: T;
  metadata?: M;
}

export function toolResult<T, M extends Record<string, unknown>>(
  envelope: ToolEnvelope<T, M>,
): CallToolResult;
```

`structuredContent` is exactly the envelope. `content` contains a short text representation of `message` for clients that do not use structured content.

Direct BRP wrappers put the decoded BRP payload in `result`. Composite/local tools may add stable metadata such as entity counts, PIDs, watch IDs, or log paths. Handlers do not invent top-level structured-content shapes.

## BRP transport

`BrpClient` uses native `fetch` against `http://127.0.0.1:<port>` with JSON-RPC 2.0 requests.

Responsibilities are intentionally small:

- monotonically increasing request ID;
- method + params serialization;
- per-call port, defaulting to 15702;
- timeout and caller abort propagation;
- invalid/malformed response detection;
- preservation of BRP `error.code`, `message`, and `data`.

No retry layer, method cache, dynamic proxy, remote host support, or alternate transport is included.

## Schemas and long-term parity

Public MCP parameters are transcribed from the pinned default upstream contracts into local Zod 4 schemas. Known schemas must not be replaced by root `z.any()`, `z.unknown()`, or catch-all objects.

Once transcribed, generated JSON Schema snapshots are committed in-repo. Those snapshots—not a live upstream checkout—become the maintained contract. A future Bevy/BRP upgrade is an explicit task that audits:

1. the 47-name catalog;
2. tool-to-BRP method tables;
3. Zod contracts and JSON-schema snapshots;
4. composites such as screenshot/name resolution;
5. the real fixture journey.

This maintenance cost is accepted as the price of eliminating the external MCP executable.

## Direct tools vs composites

Most tools are declarative mappings through one `registerDirectBrpTool` helper. The helper receives a fixed method at registration time; callers cannot choose it dynamically.

Explicit local/composite handlers are limited to behavior that actually needs orchestration:

- `world_find_entities_by_name`;
- `brp_execute` discovery validation;
- `brp_list_agent_tools` normalization;
- `brp_extras_screenshot` name/entity selection;
- watch start/list/stop;
- application discovery/launch/status/shutdown;
- log list/read/delete;
- type guides.

No other handler may call the `brp_execute` handler.

## Reflected `Name`

Entity-name lookup queries the reflected component type:

```text
bevy_ecs::name::Name
```

It performs one `world.query` using both `data.components` and `filter.with`, reads each returned Name value using the wire shape observed from Bevy 0.19, filters locally with case-sensitive `exact | prefix | suffix | contains`, and returns ascending entity IDs.

The full fixture gains `Name::new("FixturePrimary")` in the same task as this composite, and the test must exercise the actual live BRP payload before screenshot-by-name is considered complete.

## Watches

Watches are local polling tasks rather than a second BRP streaming transport.

Rules:

- IDs start at 1 and increase monotonically;
- a watch is registered only after its initial BRP read succeeds;
- `world_get_components_watch` requires at least one component type;
- default polling interval is 250 ms;
- stable canonical JSON is used only for snapshot equality;
- unchanged snapshots are not re-logged;
- `LogStore` allocates the watch log path;
- stopping an unknown watch is a tool error;
- all watches stop during server shutdown.

## Cargo and launch

`brp_list_bevy` is based on `cargo metadata --format-version 1 --no-deps` and returns binary apps/examples with deterministic ordering.

`brp_launch`:

1. resolves the requested workspace/path;
2. applies app/example search order and optional package disambiguation;
3. validates the consecutive port range;
4. runs Cargo build once for the selected target/profile;
5. parses Cargo JSON `compiler-artifact.executable` rather than predicting target paths;
6. asks `LogStore` for an app log path;
7. spawns one or more referenced child processes with consecutive ports;
8. sets `BRP_EXTRAS_PORT` after user environment merging;
9. records child metadata in memory.

No custom freshness optimizer is ported.

## Process lifecycle

Spawned children are **not** `unref()`ed.

`brp_shutdown` first requests `brp_extras/shutdown`, waits a bounded interval, then terminates a still-running tracked process if needed.

A single MCP cleanup function is used by signals and stdio/server shutdown:

```text
WatchManager.stopAll()
-> ProcessManager.shutdownAll()
-> server.close()
-> exit
```

`shutdownAll()` tries graceful BRP shutdown for known ready ports where practical, then sends ordinary process termination to any remaining tracked child. No process-tree dependency or daemon is added.

## Logs

All owned files live below:

```text
<tmp>/bevy-mcp/apps/
<tmp>/bevy-mcp/watches/
```

`LogStore` alone creates paths. `ProcessManager` receives an app log path; `WatchManager` receives a watch log path.

`brp_list_logs`, `brp_read_log`, and `brp_delete_logs` operate only inside this root. Canonical containment prevents path traversal or arbitrary file deletion.

MCP-internal observability uses stderr; there is no public trace subsystem in this PR.

## Type guides

`brp_type_guide` and `brp_all_type_guides` remain part of parity.

Implementation uses pure transforms over current registry/list responses rather than copying the upstream type-guide framework. `brp_all_type_guides` remains potentially large because changing its public contract or dropping it would violate the requested default parity. It should use bounded internal work (one relevant registry fetch/pass rather than N redundant requests) but returns the complete compatible result.

## Testing strategy

Testing proceeds by domain while remaining one PR:

1. server bootstrap + result envelope;
2. BRP transport;
3. direct world/resource schemas and mappings;
4. live fixture-backed name discovery + application tools + type guides;
5. extras and screenshot composite;
6. shared LogStore + watches;
7. Cargo discovery/build, including a real metadata check against this workspace;
8. process/app lifecycle + log tools;
9. exact 47-tool registration + local JSON-schema snapshots;
10. real MCP client -> owned server -> Bevy fixture journey;
11. CI/docs/upstream-independence cleanup.

Each implementation task gets its own test/commit/review checkpoint while all commits remain on the same implementation PR.

## Non-goals

- Reimplementing `bevy_brp_extras`.
- Publishing the Rust bridge to crates.io.
- Game-specific debug operations.
- Standalone `bevy_ecs::World` transport.
- WASM/browser relay.
- Remote-host discovery/network authentication.
- Automatic source/project rewriting.
- Persistent process/watch state.
- A custom MCP implementation.
- Rust-style macro/code generation for tool registration.
- Custom Cargo freshness detection.
- Public MCP trace/debug tools outside the default upstream catalog.

## Risks and mitigations

### Schema drift

Owning ~47 tool contracts means future Bevy/BRP upgrades require explicit maintenance. Mitigation: local Zod schemas, committed JSON-schema snapshots, exact catalog/method tests, and a pinned migration reference.

### Reflected type drift

A wrong reflected path or payload shape can make composites silently return no matches. Mitigation: use `bevy_ecs::name::Name` and add a live fixture assertion in the same task as name lookup.

### Orphaned processes

If child processes are detached/unreferenced, closing an agent session can leave windows and occupied BRP ports. Mitigation: keep children referenced and use one cleanup path for signals/stdio close.

### Large all-type-guide responses

`brp_all_type_guides` can produce a large response on large applications. This is intentionally retained for default parity in this PR. If it becomes problematic, changing that public tool is a separate explicit product decision rather than a hidden migration deviation.

## Definition of done

A clean environment containing Node.js, Rust, this repository, and the fixture Bevy app—but **no installed `bevy_brp_mcp` executable**—must:

1. install/build `@cwchanap/bevy-plugin`;
2. start it directly as an MCP stdio server;
3. expose exactly the 47 default parity tools;
4. pass local schema snapshots and domain tests;
5. discover/build/launch the real fixture;
6. exercise representative behavior from every tool family;
7. shut down watches and spawned apps without orphaning processes;
8. complete screenshot/log/type/agent-tool journeys;
9. pass Rust, Node, packed-package, independence, and Xvfb integration CI gates;
10. contain no runtime/build/install/subprocess dependency on `bevy_brp_mcp`.
