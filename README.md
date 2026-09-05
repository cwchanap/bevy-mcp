# Bevy MCP

Generic Model Context Protocol tooling for inspecting, controlling, and debugging Bevy applications. This repository provides two pieces:

- **`bevy_brp_mcp`** — the upstream general-purpose MCP server (installed via Cargo, not part of this repo). It ships the standard toolset: launch, logs, entity query, mutation, watch, type guide, screenshot, input, and diagnostics.
- **`bevy-mcp-bridge`** — a small Bevy plugin (this repo) that registers two extra generic agent tools, `world_stats` and `time_control`, into your app's BRP endpoint. The npm package `@cwchanap/bevy-plugin` is a thin launcher that delegates stdio to the upstream binary.

## Prerequisites

Install the upstream MCP server (pinned; no standalone `bevy_ecs` support in v1 — a full Bevy `App` is required):

```bash
cargo install bevy_brp_mcp --version 0.22.3 --locked
```

## Quick Start

1. Add the bridge plugin to your Bevy project:

   ```bash
   cargo add bevy-mcp-bridge --git https://github.com/cwchanap/bevy-mcp
   ```

2. Add the plugin to your app:

   ```rust
   .add_plugins(bevy_mcp_bridge::BevyMcpPlugin)
   ```

3. Connect your agent through the npm launcher (see install options below) or run `bevy_brp_mcp` directly.

## Requirements

- **Screenshots** require the Bevy `png` feature in your app:

  ```toml
  bevy = { version = "0.19", features = ["png"] }
  ```

- **Generic ECS inspection** (querying/mutating your own components and resources) requires reflection: derive `Reflect` and call `app.register_type::<T>()` for every type you want visible over BRP.
- The upstream server already provides launch, logs, query, mutation, watch, type-guide, screenshot, input, and diagnostics tools — the bridge does not reimplement any of them.

## Custom tools (`world_stats` / `time_control`)

The bridge registers exactly two generic methods:

- `bevy_mcp_world_stats` — bounded, deterministic aggregate ECS world statistics;
- `bevy_mcp_time_control` — pause, resume, or set the relative speed of `Time<Virtual>` (scale is validated before mutation).

They are not exposed as separate MCP tools. Discover them with `brp_list_agent_tools` and invoke them with `brp_execute`, passing `bevy_mcp/world_stats` / `bevy_mcp/time_control` as the method.

## Launcher configuration

The npm launcher simply executes the upstream binary with inherited stdio. To point it at a different build or location, set:

```bash
export BEVY_BRP_MCP_BIN=/path/to/bevy_brp_mcp
```

If the upstream binary is missing, the launcher fails fast with the install command.

## Agent installation

The same npm package powers every supported client (modeled after the Godot plugin marketplace flow):

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

Pi has no built-in MCP support. Install the community adapter and Agent Plugins loader, then point Pi at this repository's portable package (`plugin.json` + root `mcp.json`):

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-agent-plugins
```

The portable `plugin.json` / `mcp.json` this repo ships are the Agent Plugins 1.0 package; other Agent-Plugins-compatible clients load them through their own install flow.

All of them resolve to `@cwchanap/bevy-plugin`, which launches the upstream `bevy_brp_mcp` server.

## Development

```bash
cargo fmt --all -- --check   # format check
cargo test --workspace       # Rust tests (bridge + full-app fixture)
npm ci && npm test           # launcher unit tests
npm run smoke:packed         # smoke-test the packed npm CLI
npm run test:integration     # real MCP client -> launcher -> upstream -> Bevy fixture
```

The integration test needs a display; on Linux use `xvfb-run -a npm run test:integration`.

## License

MIT
