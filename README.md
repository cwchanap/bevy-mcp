# Bevy MCP

Model Context Protocol server for inspecting, controlling, and debugging local Bevy applications over the Bevy Remote Protocol (BRP).

The npm package `@cwchanap/bevy-plugin` **is** the MCP stdio server (bin `bevy-plugin` → `build/index.js`). It is fully repository-owned and requires no separate MCP Cargo prerequisite: install the npm package and connect.

The complete **47-tool default** surface — app launch, logs, entity query and mutation, streaming watches, type guides, screenshots, input, and diagnostics — is registered from the wire contract captured from upstream [`bevy_brp`](https://github.com/natepiano/bevy_brp) `bevy_brp_mcp` 0.22.3, checked in at `contracts/bevy-brp-mcp-0.22.3-tools.json` and redistributed under the MIT license (see `THIRD_PARTY_NOTICES.md`).

## Quick start

1. Add the bridge plugin to your Bevy project:

   ```bash
   cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
   ```

2. Add the plugin to your app:

   ```rust
   .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
   ```

3. Point your MCP client at the server (`npx -y @cwchanap/bevy-plugin`, or the `bevy-plugin` bin from a global install). The server talks to your app's BRP endpoint on `localhost:15702` and can build and launch your app through Cargo.

## What the server owns

- **47 default tools** registered from the checked-in contract through the MCP SDK's raw JSON-Schema adapter, each answering with the upstream-compatible envelope: required `status`, `message`, `call_info`; optional `metadata`, `parameters`, `result`, `error_info`.
- **Native watch streams** — `world_get_components_watch` and `world_list_components_watch` consume Bevy's native `world.get_components+watch` / `world.list_components+watch` SSE streams. No polling, no snapshot diffing. Manage registrations with `brp_list_active_watches` and `brp_stop_watch`.
- **Full type guides** — `brp_type_guide` / `brp_all_type_guides` report schema and type-kind info, spawn/insert examples, mutation paths across structs/tuples/enums/containers, curated Bevy type knowledge, and `agent_guidance`.
- **Log store** — app and watch logs live under `<tmp>/bevy-mcp/{apps,watches}`. `brp_list_logs`, `brp_read_log`, and `brp_delete_logs` take bare filenames and app-name filters only, never paths or ports.
- **Cargo runtime** — `brp_launch` builds your crate with Cargo metadata + JSON compiler artifacts (incremental, no custom freshness logic) and tracks spawned children in memory; they are referenced and shut down with the server.

## Requirements

- **Screenshots** require the Bevy `png` feature in your app:

  ```toml
  bevy = { version = "0.19", features = ["png"] }
  ```

- **Generic ECS inspection** requires reflection: derive `Reflect` and call `app.register_type::<T>()` for every type you want visible over BRP.

## Custom application methods

The Rust bridge (`crates/bevy-mcp-bridge` + `bevy_brp_extras`) remains the application-side integration and registers two extra BRP methods:

- `bevy_mcp/world_stats` — bounded, deterministic aggregate ECS world statistics;
- `bevy_mcp/time_control` — pause, resume, or set the relative speed of `Time<Virtual>`.

They are not separate top-level MCP tools. Discover them with `brp_list_agent_tools` and invoke them with `brp_execute`.

## Agent installation metadata

The repository ships one portable npm/Agent-Plugins entrypoint for Codex, Claude Code, Pi adapters, and other compatible clients. All entrypoints resolve to the same npm package.

**Codex**

```bash
codex plugin marketplace add cwchanap/bevy-mcp
codex plugin add bevy-plugin@cwchanap
```

**Claude Code / Claude plugins**

```bash
claude plugin marketplace add cwchanap/bevy-mcp
claude plugin install bevy-plugin@cwchanap
```

**Pi (via community MCP adapter)**

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-agent-plugins
```

Then install/trust this repository's portable package through Pi's Agent Plugins flow.

## Development

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

`npm test` includes the upstream-independence test, which fails if any active surface (source, scripts, CI, manifests, README/CLAUDE) reintroduces an executable dependency on the upstream binary. The integration journey runs the owned server against the real Bevy fixture (`cargo build -p bevy-mcp-fixture` first).

## License

MIT. Captured upstream contract metadata and translated portions are attributed in `THIRD_PARTY_NOTICES.md`.
