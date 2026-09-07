# Owned Bevy MCP Server Design

## Status

Approved on September 7, 2026. This design supersedes `docs/superpowers/specs/2026-09-03-generic-bevy-mcp-design.md` for the next implementation PR.

The previous design deliberately delegated the MCP server to `bevy_brp_mcp`. That boundary is removed. This repository will own the complete MCP server implementation and the complete currently exposed tool surface. The upstream project may be consulted as a behavioral reference while implementing parity, but it must not remain a runtime, build, install, subprocess, fallback, or packaging dependency.

## Goal

Ship `@cwchanap/bevy-plugin` as a self-contained TypeScript MCP server for Bevy development. A user with Node.js, Rust, and a Bevy project should be able to install the agent plugin and use the full Bevy MCP toolset without separately installing `bevy_brp_mcp`.

The existing Rust `bevy-mcp-bridge` remains the application-side integration layer. It composes `bevy_brp_extras` and registers the repository-owned `bevy_mcp/world_stats` and `bevy_mcp/time_control` BRP methods. `bevy_brp_extras` is not the upstream MCP server being removed; it remains an app-side BRP capability provider.

## Principles

- One implementation PR for the full server rebuild.
- Own every public MCP tool; no tool may use `brp_execute` as a fallback for a missing implementation.
- `brp_execute` remains as a first-class public tool because raw discovered BRP execution is itself part of the supported toolset.
- Preserve the current tool names and parameter intent as the parity contract, but do not preserve upstream internal architecture.
- Prefer Node/TypeScript-native primitives and small modules over porting Rust macro frameworks, registries, build freshness optimizers, or other upstream implementation machinery.
- Keep generic Bevy functionality only; no game-specific operations.
- No backward-compatibility layer is required for this hobby project.
- No persistence database, daemon, dependency injection framework, plugin framework, or generic schema code generator.

## Compatibility baseline

- Node.js: >=20
- MCP TypeScript SDK: `@modelcontextprotocol/server` 2.x
- MCP client used by integration tests: `@modelcontextprotocol/client` 2.x
- Schema library: Zod 4
- TypeScript: project compiler upgraded only as required by MCP SDK 2.x / Zod 4
- Bevy: 0.19.x
- `bevy_brp_extras`: 0.22.3
- Rust: >=1.95, edition 2024
- Default BRP port: 15702
- Launch-time BRP port environment variable: `BRP_EXTRAS_PORT`
- Native macOS/Linux/Windows development workflows
- Agent Plugins metadata remains 1.0.0

## Architecture

```text
Codex / Claude Code / Pi / other MCP client
                    |
                  stdio
                    v
          @cwchanap/bevy-plugin
          TypeScript MCP server
                    |
       +------------+-------------+
       |            |             |
       v            v             v
 Cargo/runtime    Watch        Type-guide
 management      manager        builder
       |            |             |
       +------------+-------------+
                    |
                BrpClient
                    |
          localhost HTTP JSON-RPC
                    v
             Bevy 0.19 app
                    |
        +-----------+------------+
        |                        |
 BrpExtrasPlugin           BevyMcpPlugin
 input/screenshot/...     world_stats/time_control
```

### MCP server

`src/index.ts` becomes the real executable entrypoint. It constructs an `McpServer`, registers all tools, connects a `StdioServerTransport`, and owns shutdown cleanup.

The package uses the official MCP SDK instead of implementing MCP framing. Tool schemas are Zod objects registered directly with the SDK. Tool handlers return MCP content plus structured content where appropriate.

### BRP client

One `BrpClient` owns BRP HTTP JSON-RPC calls.

```ts
interface BrpCallOptions {
  port?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

class BrpClient {
  call<T>(method: string, params: unknown, options?: BrpCallOptions): Promise<T>;
  discover(port?: number): Promise<unknown>;
}
```

Responsibilities:

- POST JSON-RPC 2.0 requests to `http://127.0.0.1:<port>`;
- monotonically increasing request IDs;
- default port 15702;
- timeout/abort support;
- HTTP, malformed JSON, JSON-RPC error, and connection error normalization;
- no retries hidden inside the client.

No tool except `brp_execute` accepts an arbitrary BRP method name.

### Tool registration

Tools are grouped by domain modules, not generated through a macro/DSL framework. A small helper may register simple direct BRP wrappers, but composite tools keep explicit handlers.

```text
src/tools/
  register.ts
  world.ts
  resources.ts
  discovery.ts
  extras.ts
  watches.ts
  app.ts
  logs.ts
  type-guides.ts
  agent-tools.ts
```

Every public tool is independently visible in the MCP tool list and independently tested.

## Complete parity catalog

The owned server exposes 49 tools. The two trace/debug tools are always available in the TypeScript server instead of being hidden behind a Rust compile feature.

### Core world / BRP tools

| MCP tool | Implementation |
| --- | --- |
| `world_list_components` | direct `world.list_components` |
| `world_get_components` | direct `world.get_components` |
| `world_despawn_entity` | direct `world.despawn_entity` |
| `world_insert_components` | direct `world.insert_components` |
| `world_remove_components` | direct `world.remove_components` |
| `world_list_resources` | direct `world.list_resources` |
| `world_get_resources` | direct `world.get_resources` |
| `world_insert_resources` | direct `world.insert_resources` |
| `world_remove_resources` | direct `world.remove_resources` |
| `world_mutate_resources` | direct `world.mutate_resources` |
| `world_mutate_components` | direct `world.mutate_components` |
| `rpc_discover` | direct `rpc.discover` |
| `world_query` | direct `world.query` |
| `world_find_entities_by_name` | local composite using reflected `Name` data |
| `world_spawn_entity` | direct `world.spawn_entity` |
| `world_trigger_event` | direct `world.trigger_event` |
| `registry_schema` | direct `registry.schema` |
| `world_reparent_entities` | direct `world.reparent_entities` |
| `world_get_components_watch` | local watch manager + `world.get_components` polling |
| `world_list_components_watch` | local watch manager + `world.list_components` polling |
| `brp_execute` | discover-validated raw BRP call |
| `brp_list_agent_tools` | app-published agent-tool catalog |

### BRP extras tools

| MCP tool | Implementation |
| --- | --- |
| `brp_extras_screenshot` | explicit composite, including selector validation/name resolution |
| `brp_extras_send_keys` | direct `brp_extras/send_keys` |
| `brp_extras_type_text` | direct `brp_extras/type_text` |
| `brp_extras_set_window_title` | direct `brp_extras/set_window_title` |
| `brp_extras_move_mouse` | direct `brp_extras/move_mouse` |
| `brp_extras_send_mouse_button` | direct `brp_extras/send_mouse_button` |
| `brp_extras_click_mouse` | direct `brp_extras/click_mouse` |
| `brp_extras_double_click_mouse` | direct `brp_extras/double_click_mouse` |
| `brp_extras_drag_mouse` | direct `brp_extras/drag_mouse` |
| `brp_extras_scroll_mouse` | direct `brp_extras/scroll_mouse` |
| `brp_extras_pinch_gesture` | direct `brp_extras/pinch_gesture` |
| `brp_extras_rotation_gesture` | direct `brp_extras/rotation_gesture` |
| `brp_extras_double_tap_gesture` | direct `brp_extras/double_tap_gesture` |
| `brp_extras_get_diagnostics` | direct `brp_extras/get_diagnostics` |

### Watch tools

| MCP tool | Implementation |
| --- | --- |
| `brp_stop_watch` | stop one local watch by ID |
| `brp_list_active_watches` | return local watch registry |

### Application tools

| MCP tool | Implementation |
| --- | --- |
| `brp_list_bevy` | `cargo metadata --format-version 1 --no-deps` target discovery |
| `brp_launch` | Cargo build + JSON compiler artifact parsing + executable spawn |
| `brp_shutdown` | BRP graceful shutdown, then bounded tracked-process termination fallback |
| `brp_status` | tracked process state plus live BRP probe |

### Log / trace tools

| MCP tool | Implementation |
| --- | --- |
| `brp_list_logs` | local app/watch/MCP log store |
| `brp_read_log` | bounded local file read/tail |
| `brp_delete_logs` | delete matching owned log files |
| `brp_get_trace_log_path` | return current MCP trace file path |
| `brp_set_tracing_level` | change local trace threshold |

### Type tools

| MCP tool | Implementation |
| --- | --- |
| `brp_type_guide` | build one mutation/read guide from `registry.schema` |
| `brp_all_type_guides` | build guides for all registered types |

## Cargo discovery and launch

### Discovery

`CargoRuntime.listTargets(root)` runs:

```bash
cargo metadata --format-version 1 --no-deps --manifest-path <resolved Cargo.toml>
```

It returns normalized app/example targets containing at minimum:

```ts
interface BevyTarget {
  name: string;
  kind: 'app' | 'example';
  packageName: string;
  manifestPath: string;
  packageRoot: string;
}
```

When the caller supplies `path`, targets outside the canonicalized path scope are filtered out even when Cargo metadata expands to a parent workspace.

### Launch

`brp_launch` supports:

- `target_name`;
- optional `profile` (`debug` or `release`);
- optional root `path`;
- optional `package_name` disambiguation;
- `port` default 15702;
- `instance_count` default 1;
- optional environment map;
- `search_order` (`app` default or `example`);
- optional process args.

For each selected target the server runs Cargo build with `--message-format=json-render-diagnostics`, parses the matching `compiler-artifact.executable`, then spawns that executable with:

```text
BRP_EXTRAS_PORT=<assigned port>
```

`instance_count > 1` receives consecutive ports from the base port. Always invoking Cargo build is intentional: Cargo performs its own incremental freshness check, so this avoids porting upstream's custom build-freshness subsystem.

`ProcessManager` tracks PID, target/package, kind, port, start time, profile, and log file. There is no persistent process database.

## Logs and tracing

All files owned by the package live below one root such as:

```text
<os tmp>/bevy-mcp/
  apps/
  watches/
  mcp/
```

App stdout/stderr go to app log files. Watches record change events as newline-delimited JSON or readable timestamped JSON lines. MCP trace logging records server/tool/BRP lifecycle diagnostics.

Log tools never read arbitrary filesystem paths; they operate on file names or IDs resolved inside the owned log root.

Trace levels are `off`, `error`, `warn`, `info`, `debug`, and `trace`. `brp_set_tracing_level` updates the in-process logger; no restart is required.

## Watches

`WatchManager` is the sole owner of watch state.

```ts
interface ActiveWatch {
  id: string;
  kind: 'get_components' | 'list_components';
  entity: number;
  types?: string[];
  port: number;
  startedAt: string;
  logPath: string;
}
```

A watch starts only after an initial BRP request succeeds. `world_get_components_watch` requires at least one component type. The manager takes an initial snapshot, polls the appropriate ordinary BRP read, writes only changed snapshots, and uses stable deep JSON equality after canonical key ordering.

Default poll interval: 250 ms. Watch IDs are UUIDs. `brp_stop_watch` aborts the polling task and closes its log stream. Server shutdown aborts every active watch.

The watch tools are implemented locally rather than depending on `+watch` transport behavior. This keeps the implementation small and testable while preserving the user-facing watch capability.

## Composite discovery tools

### `world_find_entities_by_name`

Query reflected `bevy_core::name::Name` values, then apply the requested exact/contains/prefix matching locally. Return canonical entity IDs and names in deterministic entity-ID order. This tool is a convenience composite, not a raw `world.query` alias.

### `brp_extras_screenshot`

Parameters support full-screen/camera capture plus mutually exclusive `entity` or exact `name` selection and optional padding. Invalid selector combinations fail before a BRP request. Exact name capture resolves through `world_find_entities_by_name`; zero matches fail, multiple matches fail with candidate IDs, and one match calls `brp_extras/screenshot` with the resolved entity ID.

### `brp_list_agent_tools`

Read the application agent-tool catalog supplied by `BrpExtrasPlugin`, preserve its typed parameter/result schemas, and return it as an MCP-friendly structured result.

### `brp_execute`

Call `rpc.discover` first and reject methods absent from the live app catalog. Only then issue the requested raw BRP call. Other tool handlers must not call `brp_execute` internally.

## Type guides

Type guides are built locally from `registry.schema` rather than copied from upstream text files.

For one registered type the guide should include:

- full type path and short name;
- whether registry metadata identifies it as a component/resource when available;
- JSON shape and required fields;
- enum variants;
- nested referenced types needed to construct a valid value;
- concrete guidance for `world_insert_components` / `world_mutate_components` or resource equivalents;
- read-only guidance when the schema is not constructible.

`brp_all_type_guides` calls `registry.schema` once and builds all guides from that response rather than issuing one request per type.

## Result and error behavior

Use one small helper for successful tool results:

```ts
function toolResult(message: string, structuredContent?: unknown) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
  };
}
```

Expected failures are returned as MCP tool errors with concise messages and structured diagnostic data where useful. Preserve BRP error code/message/data. Avoid an elaborate local error class hierarchy: `BrpError`, `ToolInputError`, and normal `Error` are sufficient.

## Testing strategy

### Unit tests

- exact 49-tool catalog test;
- every direct tool's MCP name -> BRP method mapping;
- input schema validation for every tool;
- BRP transport success/error/timeout/malformed response;
- screenshot/name-resolution composites;
- watch start/change/stop/list behavior;
- Cargo metadata target normalization/path scoping;
- Cargo compiler-artifact parsing;
- process tracking and shutdown fallback;
- log path containment/read/tail/delete;
- type-guide generation;
- upstream-independence guard.

### Real integration

Expand the existing full Bevy fixture with reflected components/resources and named entities. Run the shipped Node MCP server through the official MCP client and test:

1. initialize/list tools and assert all 49 names;
2. discover the fixture;
3. launch it on a test port;
4. list/query/get/mutate components;
5. get/mutate a reflected resource;
6. spawn and despawn an entity;
7. find a named entity;
8. start a watch, cause a mutation, observe a watch log change, stop it;
9. generate a type guide;
10. list and execute `bevy_mcp/world_stats` and `bevy_mcp/time_control` through agent-tool support;
11. diagnostics and at least one input operation;
12. screenshot to a temporary PNG;
13. read the launched app log;
14. shut down and verify process exit.

## Upstream-independence gate

The finished package must contain no runtime/build/install dependency on `bevy_brp_mcp`.

A CI script scans production/package paths (`src`, `test`, `scripts`, `.github`, package manifests, plugin metadata, and README) and fails on references that install, execute, import, or require `bevy_brp_mcp`. Design/history documents may name it only to explain the removed architecture.

The integration job must not run `cargo install bevy_brp_mcp` and must pass on a clean runner without that executable.

## Documentation migration

The implementation PR deletes the obsolete `2026-09-03` upstream-delegation spec/plan once the new server is implemented, then rewrites README architecture, prerequisites, development commands, and CI notes around the self-contained npm MCP server.

The agent-plugin metadata remains unchanged in shape: clients still execute `npx -y @cwchanap/bevy-plugin@<version>`. Only the implementation behind that command changes.

## Non-goals

- Rebuilding `bevy_brp_extras` inside TypeScript/Rust in this task.
- Game-specific debug/gameplay tools.
- WASM/browser relay.
- Remote-network BRP discovery.
- Persistent process/watch state across MCP restarts.
- Automatic editing of consumer Bevy projects.
- Cross-engine abstraction shared with Godot.
- Copying upstream Rust macro/meta-programming architecture.
- Matching upstream internal log file names, cache implementation, build-freshness optimization, or source layout.

## Definition of done

On a clean machine with Node.js, Rust, this repository, and the fixture Bevy project—but without `bevy_brp_mcp` installed—the packaged `@cwchanap/bevy-plugin` executable:

1. starts as a valid MCP stdio server;
2. exposes all 49 owned tools;
3. implements every tool locally rather than using a missing-tool fallback;
4. completes the real Bevy integration journey;
5. supports the existing `bevy-mcp-bridge` application methods;
6. passes package smoke tests and CI; and
7. contains zero runtime/build/install dependency on the removed upstream MCP server.
