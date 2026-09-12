import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError } from '../brp/errors.js';
import { computeRelativePath, type BevyTarget } from '../runtime/cargo.js';
import type { TrackedProcess } from '../runtime/process-manager.js';
import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/**
 * Process/app lifecycle tools: brp_list_bevy, brp_launch, brp_status,
 * brp_shutdown. Launches build ONE cargo target per selected target/profile
 * (compiler-artifact executable, never a predicted `target/` path and never
 * `cargo run`) and spawn referenced children through the ProcessManager.
 *
 * Port/profile/instance-count validation semantics and the search-order,
 * package-disambiguation, and not-found error shapes are translated from
 * upstream `bevy_brp_mcp` 0.22.3 (`src/app_tools/`, MIT, see
 * THIRD_PARTY_NOTICES.md); the upstream predicted-path freshness logic is
 * intentionally replaced by Cargo incremental compilation.
 */

/** Upstream `brp_tools/constants.rs` valid BRP port range (MIT). */
const MIN_PORT = 1024;
const MAX_PORT = 65534;
/** Upstream `app_tools/constants.rs` instance/profile defaults (MIT). */
const MIN_INSTANCE_COUNT = 1;
const MAX_INSTANCE_COUNT = 100;
const DEFAULT_PROFILE = 'debug';
/** Bounded interval between the graceful shutdown call and termination. */
const SHUTDOWN_GRACE_MS = 5_000;

type TargetKind = 'app' | 'example';
type BrpLevel = 'extras' | 'brp_only' | 'none';

// BRP plugin source probes, translated from upstream
// `src/app_tools/targets/cargo_detector.rs` + `targets/constants.rs` (MIT):
// `extras` if the file imports BrpExtrasPlugin, `brp_only` if it imports
// RemotePlugin (via `bevy::remote` or `bevy_remote`) without extras, else
// `none`. Glob forms require the prefix AND the plugin name.
const EXTRAS_IMPORT = 'use bevy_brp_extras::BrpExtrasPlugin';
const EXTRAS_GLOB_PREFIX = 'use bevy_brp_extras::{';
const EXTRAS_PLUGIN_NAME = 'BrpExtrasPlugin';
const REMOTE_IMPORTS = [
  'use bevy::remote::RemotePlugin',
  'use bevy_remote::RemotePlugin',
];
const REMOTE_GLOB_PREFIXES = ['use bevy::remote::{', 'use bevy_remote::{'];
const REMOTE_PLUGIN_NAME = 'RemotePlugin';

function fileBrpLevel(path: string): BrpLevel {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return 'none';
  }
  const has = (needle: string): boolean => content.includes(needle);
  const glob = (prefix: string, name: string): boolean => has(prefix) && has(name);
  if (has(EXTRAS_IMPORT) || glob(EXTRAS_GLOB_PREFIX, EXTRAS_PLUGIN_NAME)) return 'extras';
  if (
    REMOTE_IMPORTS.some(has) ||
    REMOTE_GLOB_PREFIXES.some((prefix) => glob(prefix, REMOTE_PLUGIN_NAME))
  ) {
    return 'brp_only';
  }
  return 'none';
}

/** Recursively check a directory tree for BRP plugin usage (upstream parity). */
async function dirUsesBrpPlugins(dir: string, depth = 0): Promise<boolean> {
  // ponytail: depth cap instead of symlink-cycle tracking; src/ trees are shallow
  if (depth > 32) return false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await dirUsesBrpPlugins(path, depth + 1)) return true;
    } else if (entry.isFile() && entry.name.endsWith('.rs') && fileBrpLevel(path) !== 'none') {
      return true;
    }
  }
  return false;
}

async function brpLevelFor(target: BevyTarget): Promise<BrpLevel> {
  // Upstream hybrid: bins report a level only if their package's src/ tree
  // uses BRP plugins; the concrete level comes from the target source file —
  // cargo metadata's own `src_path`, so custom `[[bin]] path` /
  // `[[example]] path` layouts resolve correctly.
  if (target.kind === 'app' && !(await dirUsesBrpPlugins(join(target.packageRoot, 'src')))) {
    return 'none';
  }
  return fileBrpLevel(target.srcPath);
}

/**
 * Upstream reports each target's predicted cargo artifact paths and whether
 * they exist (display data only — launches always build through Cargo
 * incremental compilation and resolve the executable from compiler
 * artifacts). Ported from upstream `create_builds_json` (MIT).
 */
function buildsFor(target: BevyTarget): Record<string, { path: string; built: boolean }> {
  const predicted = (profile: string): string => {
    const artifact =
      target.kind === 'example'
        ? join(target.workspaceRoot, 'target', profile, 'examples', target.name)
        : join(target.workspaceRoot, 'target', profile, target.name);
    return process.platform === 'win32' ? `${artifact}.exe` : artifact;
  };
  return {
    debug: { path: predicted('debug'), built: existsSync(predicted('debug')) },
    release: { path: predicted('release'), built: existsSync(predicted('release')) },
  };
}

/** `brp_list_bevy {path?}`: cargo metadata targets with kind + brp_level. */
export function listBevyHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_list_bevy' } as const;
    const root = typeof args.path === 'string' ? args.path : undefined;
    try {
      const targets = await services.cargo.listTargets(root);
      const base = resolve(root ?? process.cwd());
      const items = await Promise.all(
        targets.map(async (target) => ({
          name: target.name,
          kind: target.kind,
          package_name: target.packageName,
          brp_level: await brpLevelFor(target),
          workspace_root: target.workspaceRoot,
          manifest_path: target.manifestPath,
          relative_path: computeRelativePath(target.packageRoot, base),
          builds: buildsFor(target),
        })),
      );
      return toolSuccess(callInfo, `Found ${items.length} Bevy targets`, {
        metadata: { count: items.length },
        result: items,
        parameters: args,
      });
    } catch (error) {
      return toolError(callInfo, error instanceof Error ? error.message : String(error), {
        parameters: args,
      });
    }
  };
}

interface LaunchPlan {
  targetName: string;
  profile: 'debug' | 'release';
  path?: string;
  packageName?: string;
  ports: number[];
  env?: Record<string, string>;
  searchOrder: 'app' | 'example';
  args?: string[];
}

/** Validate the captured launch parameters; throws Error with the
 * upstream-compatible message on any invalid value. */
function parseLaunchArgs(args: Record<string, unknown>): LaunchPlan {
  const targetName = args.target_name;
  if (typeof targetName !== 'string' || targetName === '') {
    throw new Error('target_name is required');
  }
  const profileArg = args.profile;
  if (profileArg !== undefined && profileArg !== 'debug' && profileArg !== 'release') {
    throw new Error(`Invalid profile '${String(profileArg)}': must be debug or release`);
  }
  const profile = profileArg ?? DEFAULT_PROFILE;
  const searchOrder = args.search_order ?? 'app';
  if (searchOrder !== 'app' && searchOrder !== 'example') {
    throw new Error(`Invalid search_order '${String(searchOrder)}': must be app or example`);
  }
  const portArg = args.port ?? DEFAULT_BRP_PORT;
  if (
    typeof portArg !== 'number' ||
    !Number.isInteger(portArg) ||
    portArg < MIN_PORT ||
    portArg > MAX_PORT
  ) {
    throw new Error(`Invalid port ${String(portArg)}: must be in range ${MIN_PORT}-${MAX_PORT}`);
  }
  const countArg = args.instance_count ?? 1;
  if (
    typeof countArg !== 'number' ||
    !Number.isInteger(countArg) ||
    countArg < MIN_INSTANCE_COUNT ||
    countArg > MAX_INSTANCE_COUNT
  ) {
    throw new Error(
      `Invalid instance count ${String(countArg)}: must be in range ${MIN_INSTANCE_COUNT}-${MAX_INSTANCE_COUNT}`,
    );
  }
  // Consecutive ports for the instances: reject ranges beyond MAX_PORT.
  const lastPort = portArg + (countArg - 1);
  if (lastPort > MAX_PORT) {
    throw new Error(
      `Port range ${portArg} to ${lastPort} exceeds maximum valid port ${MAX_PORT}`,
    );
  }
  const ports = Array.from({ length: countArg }, (_, i) => portArg + i);
  const env =
    typeof args.env === 'object' && args.env !== null && !Array.isArray(args.env)
      ? (Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        ) as Record<string, string>)
      : undefined;
  const launchArgs = Array.isArray(args.args)
    ? args.args.map((arg) => String(arg))
    : undefined;
  return {
    targetName,
    profile,
    path: typeof args.path === 'string' ? args.path : undefined,
    packageName: typeof args.package_name === 'string' ? args.package_name : undefined,
    ports,
    env,
    searchOrder,
    args: launchArgs,
  };
}

interface AvailableTarget {
  name: string;
  kind: string;
  path: string;
}

function availableTargets(targets: BevyTarget[], base: string): AvailableTarget[] {
  return targets.map((target) => ({
    name: target.name,
    kind: target.kind,
    path: computeRelativePath(target.packageRoot, base),
  }));
}

interface ResolveFailure {
  message: string;
  errorInfo: Record<string, unknown>;
}

/**
 * Resolve the launch target with the captured search order and package
 * disambiguation: search the preferred kind first, then the other; ambiguous
 * names across packages are an error listing candidate packages unless
 * `package_name` narrows the match.
 */
async function resolveTarget(
  services: BevyMcpServices,
  plan: LaunchPlan,
  base: string,
): Promise<{ target: BevyTarget; kind: TargetKind } | ResolveFailure> {
  const targets = await services.cargo.listTargets(plan.path);
  const order: TargetKind[] = plan.searchOrder === 'example' ? ['example', 'app'] : ['app', 'example'];
  for (const kind of order) {
    const matches = targets.filter((t) => t.name === plan.targetName && t.kind === kind);
    if (matches.length === 0) continue;

    const filtered = plan.packageName
      ? matches.filter((t) => t.packageName === plan.packageName)
      : matches;
    if (filtered.length === 0) {
      return {
        message: `${kind} \`${plan.targetName}\` not found in package \`${plan.packageName}\`. Available in: ${matches.map((t) => t.packageName).join(', ')}`,
        errorInfo: {
          target_name: plan.targetName,
          target_type: kind,
          searched_package_name: plan.packageName,
          available_package_names: matches.map((t) => t.packageName),
        },
      };
    }
    if (filtered.length > 1) {
      return {
        message: `Found multiple ${kind}s named \`${plan.targetName}\`. Please specify \`package_name\` to disambiguate.`,
        errorInfo: {
          available_package_names: filtered.map((t) => t.packageName),
          target_name: plan.targetName,
          target_type: kind,
        },
      };
    }
    return { target: filtered[0]!, kind };
  }
  return {
    message: `No app or example named \`${plan.targetName}\` found`,
    errorInfo: {
      target_name: plan.targetName,
      available_targets: availableTargets(targets, base),
    },
  };
}

/** `brp_launch`: resolve, build once, spawn instance_count referenced children
 * on consecutive ports with per-instance LogStore app logs. */
export function launchHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_launch' } as const;
    try {
      const plan = parseLaunchArgs(args);
      const base = resolve(plan.path ?? process.cwd());
      const resolved = await resolveTarget(services, plan, base);
      if ('message' in resolved) {
        return toolError(callInfo, resolved.message, {
          parameters: args,
          error_info: resolved.errorInfo,
        });
      }
      const { target, kind } = resolved;

      // ONE cargo build per selected target/profile; the executable comes
      // from the compiler artifact, never a predicted path, never cargo run.
      const buildStarted = Date.now();
      const { executable } = await services.cargo.build(target, plan.profile);
      const launchDurationMs = Date.now() - buildStarted;

      const instances: { pid: number; log_file: string; port: number }[] = [];
      const started: TrackedProcess[] = [];
      try {
        for (const port of plan.ports) {
          const log = await services.logStore.createAppLog(plan.targetName);
          const tracked = services.processes.launch({
            appName: plan.targetName,
            executable,
            args: plan.args,
            env: { ...plan.env, CARGO_MANIFEST_DIR: target.packageRoot },
            port,
            logPath: log.path,
            cwd: target.packageRoot,
          });
          started.push(tracked);
          instances.push({ pid: tracked.pid, log_file: log.path, port });
        }
      } catch (error) {
        // A partial launch must not leave already-spawned instances running:
        // terminate every child this request started before reporting failure.
        const results = await Promise.allSettled(
          started.map((child) => services.processes.terminate(child)),
        );
        // A rejected termination means that child may still be alive; the
        // reported launch error must name those PIDs so none are orphaned
        // silently.
        const surviving = started.filter((_, index) => results[index]!.status === 'rejected');
        if (surviving.length > 0) {
          const pids = surviving.map((child) => child.pid).join(', ');
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${cause} (rollback incomplete: child pid(s) ${pids} may still be running)`,
          );
        }
        throw error;
      }

      const portRange =
        instances.length === 1
          ? String(instances[0]!.port)
          : `${instances[0]!.port}-${instances[instances.length - 1]!.port}`;
      return toolSuccess(
        callInfo,
        `Successfully launched ${instances.length} instance(s) of ${plan.targetName} on ports ${portRange}`,
        {
          metadata: {
            target_name: plan.targetName,
            working_directory: process.cwd(),
            profile: plan.profile,
            ...(kind === 'app'
              ? { binary_path: executable }
              : { package_name: target.packageName }),
            launch_duration_ms: launchDurationMs,
            launch_timestamp: new Date().toISOString(),
            workspace: basename(target.workspaceRoot),
            launched_as: kind,
          },
          // Upstream `#[to_result]` places the bare instance array.
          result: instances,
          parameters: args,
        },
      );
    } catch (error) {
      return toolError(callInfo, error instanceof Error ? error.message : String(error), {
        parameters: args,
      });
    }
  };
}

async function isBrpResponding(services: BevyMcpServices, port: number): Promise<boolean> {
  try {
    await services.brp.discover(port);
    return true;
  } catch (error) {
    if (!(error instanceof BrpError)) throw error;
    return false;
  }
}

interface InstanceSelection {
  tracked?: TrackedProcess;
  /** All alive same-name instances when no port was given and the match is
   * ambiguous (caller must pass `port`). */
  ambiguous?: TrackedProcess[];
}

/**
 * Pick the tracked child for brp_status/brp_shutdown. With an explicit port
 * the match is app name AND port (multiple instances of one app live on
 * consecutive ports); without one there must be exactly one alive instance,
 * otherwise the selection is reported as ambiguous.
 */
function selectInstance(
  processes: BevyMcpServices['processes'],
  appName: string,
  port: number,
  portProvided: boolean,
): InstanceSelection {
  const alive = processes.findByApp(appName).filter((process) => process.isAlive());
  if (portProvided) {
    return { tracked: alive.find((process) => process.port === port) };
  }
  if (alive.length > 1) return { ambiguous: alive };
  return { tracked: alive[0] };
}

/** The upstream-shaped error naming every candidate instance. */
function ambiguousInstanceError(
  callInfo: { mcp_tool: string },
  appName: string,
  instances: TrackedProcess[],
  args: Record<string, unknown>,
): CallToolResult {
  const ports = [...new Set(instances.map((instance) => instance.port))].sort((a, b) => a - b);
  return toolError(
    callInfo,
    `Multiple running instances of '${appName}' found (ports ${ports.join(', ')}). Specify 'port' to target one instance.`,
    {
      parameters: args,
      error_info: {
        app_name: appName,
        instances: instances.map((instance) => ({ pid: instance.pid, port: instance.port })),
      },
    },
  );
}

/** `brp_status {app_name, port?}`: tracked-process state combined with a live
 * `rpc.discover` readiness probe on the app's port. */
export function statusHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_status' } as const;
    const appName = typeof args.app_name === 'string' ? args.app_name : undefined;
    if (appName === undefined) {
      return toolError(callInfo, 'app_name is required', { parameters: args });
    }
    const portProvided = typeof args.port === 'number';
    const requestedPort = portProvided ? (args.port as number) : DEFAULT_BRP_PORT;
    const selection = selectInstance(services.processes, appName, requestedPort, portProvided);
    if (selection.ambiguous) {
      return ambiguousInstanceError(callInfo, appName, selection.ambiguous, args);
    }
    const tracked = selection.tracked;
    // An omitted port targets the selected instance's own port; the default
    // applies only when nothing tracked is selected (foreign-process probe).
    const port = tracked?.port ?? requestedPort;
    const responding = await isBrpResponding(services, port);

    if (tracked) {
      if (responding) {
        return toolSuccess(
          callInfo,
          `Process '${appName}' (PID: ${tracked.pid}) is running with BRP enabled on port ${port}`,
          {
            metadata: { app_name: appName, pid: tracked.pid, port },
            parameters: args,
          },
        );
      }
      return toolError(
        callInfo,
        `Process '${appName}' (PID: ${tracked.pid}) is running but not responding to BRP on port ${port}. Make sure RemotePlugin is added to your Bevy app.`,
        { parameters: args, error_info: { app_name: appName, pid: tracked.pid, port } },
      );
    }

    const message = responding
      ? `Process '${appName}' not found. BRP is responding on port ${port} - another process may be using it.`
      : `Process '${appName}' not found and BRP is not responding on port ${port}.`;
    return toolError(callInfo, message, {
      parameters: args,
      error_info: { app_name: appName, brp_responding_on_port: responding, port },
    });
  };
}

/** `brp_shutdown {app_name, port?}`: graceful `brp_extras/shutdown` first,
 * then terminate a tracked child still alive after the bounded interval. */
export function shutdownHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_shutdown', brp_method: 'brp_extras/shutdown' } as const;
    const appName = typeof args.app_name === 'string' ? args.app_name : undefined;
    if (appName === undefined) {
      return toolError(callInfo, 'app_name is required', { parameters: args });
    }
    const portProvided = typeof args.port === 'number';
    const requestedPort = portProvided ? (args.port as number) : DEFAULT_BRP_PORT;
    const selection = selectInstance(services.processes, appName, requestedPort, portProvided);
    if (selection.ambiguous) {
      return ambiguousInstanceError(callInfo, appName, selection.ambiguous, args);
    }
    const tracked = selection.tracked;
    // Same effective-port rule as brp_status: the selected instance's own
    // port wins over the default when `port` was omitted.
    const port = tracked?.port ?? requestedPort;

    let brpShutdown = false;
    let responsePid: number | undefined;
    try {
      const result = (await services.brp.call('brp_extras/shutdown', undefined, { port })) as {
        pid?: unknown;
      } | undefined;
      brpShutdown = true;
      if (typeof result?.pid === 'number' && Number.isInteger(result.pid) && result.pid > 0) {
        responsePid = result.pid;
      }
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
    }

    if (!brpShutdown && !tracked) {
      return toolError(callInfo, `Process '${appName}' is not currently running`, {
        parameters: args,
        error_info: { app_name: appName },
      });
    }

    let method: 'clean_shutdown' | 'process_kill';
    if (tracked === undefined) {
      // No tracked child: the graceful call answered for a foreign process.
      method = 'clean_shutdown';
    } else if (
      brpShutdown && (await services.processes.waitForExit(tracked, SHUTDOWN_GRACE_MS))
    ) {
      method = 'clean_shutdown';
    } else {
      // BRP unreachable, or the child survived the bounded graceful window.
      await services.processes.terminate(tracked);
      method = 'process_kill';
    }

    const pid = tracked?.pid ?? responsePid ?? 0;
    return toolSuccess(
      callInfo,
      method === 'clean_shutdown'
        ? `Successfully initiated graceful shutdown for '${appName}' (PID: ${pid}) via bevy_brp_extras`
        : `Terminated process '${appName}' (PID: ${pid}) using kill`,
      {
        metadata: {
          app_name: appName,
          pid,
          // Upstream serializes the method field through its
          // `#[serde(rename = "shutdown_method")]` attribute.
          shutdown_method: method,
          port,
          ...(method === 'process_kill'
            ? { warning: 'Consider adding bevy_brp_extras for clean shutdown' }
            : {}),
        },
        parameters: args,
      },
    );
  };
}