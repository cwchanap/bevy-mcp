# Bevy MCP

Generic Model Context Protocol tooling for inspecting, controlling, and debugging Bevy applications.

> **Active migration:** Draft PR #3 is replacing the current external `bevy_brp_mcp` launcher dependency with a repository-owned TypeScript MCP server. Until that implementation lands, the runtime below still describes the current behavior. The approved replacement design is in `docs/superpowers/specs/2026-09-07-owned-bevy-mcp-server-design.md` and its implementation plan is in `docs/superpowers/plans/2026-09-07-owned-bevy-mcp-server.md`.

The migration target is a self-contained npm MCP server owning the full 47-tool default catalog, while keeping `bevy-mcp-bridge`/`bevy_brp_extras` as the application-side BRP integration. No new work should deepen the external MCP executable dependency.

## Current runtime

Today this repository still provides two pieces while the migration is in progress:

- **`bevy_brp_mcp`** — the upstream general-purpose MCP server (installed via Cargo, not part of this repo). It currently ships the standard toolset: launch, logs, entity query, mutation, watch, type guide, screenshot, input, and diagnostics.
- **`bevy-mcp-bridge`** — a small Bevy plugin (this repo) that registers two extra generic agent tools, `world_stats` and `time_control`, into your app's BRP endpoint. The npm package `@cwchanap/bevy-plugin` is currently a thin TypeScript launcher compiled to JavaScript that delegates stdio to the upstream binary.

The September 7 migration removes the first dependency and turns the npm package into the MCP server itself. This README will be rewritten to the final owned-server instructions before the implementation PR is merged.

## Current prerequisites

Until the migration implementation lands, the current runtime still requires:

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

This prerequisite is explicitly scheduled for deletion by the September 7 plan and must not be copied into new integration paths.

## Current quick start

1. Add the bridge plugin to your Bevy project:

   ```bash
   cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
   ```

2. Add the plugin to your app:

   ```rust
   .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
   ```

3. Connect your agent through the npm launcher while the migration is still in progress.

## Requirements

- **Screenshots** require the Bevy `png` feature in your app:

  ```toml
  bevy = { version = "0.19", features = ["png"] }
  ```

- **Generic ECS inspection** requires reflection: derive `Reflect` and call `app.register_type::<T>()` for every type you want visible over BRP.

## Custom application methods

The bridge registers two generic methods:

- `bevy_mcp/world_stats` — bounded, deterministic aggregate ECS world statistics;
- `bevy_mcp/time_control` — pause, resume, or set the relative speed of `Time<Virtual>`.

They are not separate top-level MCP tools. Discover them with `brp_list_agent_tools` and invoke them with `brp_execute` using `bevy_mcp/world_stats` or `bevy_mcp/time_control`.

## Agent installation metadata

The repository ships one portable npm/Agent-Plugins entrypoint for Codex, Claude Code, Pi adapters, and other compatible clients. The metadata shape remains unchanged during the migration; only the npm executable changes from a launcher into the actual MCP server.

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
npm ci
npm run typecheck
npm run build
npm test
npm run smoke:packed
npm run test:integration
```

During the owned-server migration, follow the September 7 implementation plan for the additional no-upstream and live-name smoke gates.

## License

MIT
