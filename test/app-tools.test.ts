import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { BrpCallOptions, BrpClient } from '../src/brp/client.js';
import { BrpError } from '../src/brp/errors.js';
import type { BevyTarget, CargoRunner } from '../src/runtime/cargo.js';
import { CargoRuntime } from '../src/runtime/cargo.js';
import { LogStore } from '../src/runtime/log-store.js';
import type { LaunchSpec, ProcessService, TrackedProcess } from '../src/runtime/process-manager.js';
import type { BevyMcpServices } from '../src/services.js';
import { loadToolContractCatalog } from '../src/tool-contracts.js';
import { registerAppTools } from '../src/tools/register.js';
import type { ToolCallJsonResponse } from '../src/tools/response.js';

// Isolated workspace + LogStore roots per test file (node:test runs files as
// processes). Package roots must be real directories: launch sets them as
// cwd/CARGO_MANIFEST_DIR and list_bevy scans sources for brp_level.
const BASE = mkdtempSync(join(tmpdir(), 'bevy-mcp-app-tools-'));
const PKG_A = join(BASE, 'pkg_a');
const PKG_B = join(BASE, 'pkg_b');

mkdirSync(join(PKG_A, 'src', 'bin'), { recursive: true });
mkdirSync(join(PKG_B, 'src'), { recursive: true });
mkdirSync(join(PKG_B, 'examples'), { recursive: true });
// pkg_a's src tree registers BrpExtrasPlugin -> 'extras' level.
writeFileSync(join(PKG_A, 'src', 'main.rs'), 'use bevy_brp_extras::BrpExtrasPlugin;\n');
// pkg_a's secondary bins have their own src_path files (custom layout).
writeFileSync(join(PKG_A, 'src', 'bin', 'both.rs'), 'use bevy_remote::RemotePlugin;\n');
writeFileSync(join(PKG_A, 'src', 'bin', 'dup.rs'), 'fn main() {}\n');
writeFileSync(join(PKG_B, 'src', 'main.rs'), 'fn main() {}\n');
// pkg_b's demo example imports RemotePlugin only -> 'brp_only' level.
writeFileSync(join(PKG_B, 'examples', 'demo.rs'), 'use bevy::remote::RemotePlugin;\n');
writeFileSync(join(PKG_B, 'examples', 'both.rs'), 'fn main() {}\n');

const METADATA = {
  packages: [
    {
      name: 'pkg_a',
      manifest_path: join(PKG_A, 'Cargo.toml'),
      dependencies: [{ name: 'bevy' }],
      targets: [
        { name: 'fixture', kind: ['bin'], src_path: join(PKG_A, 'src', 'main.rs') },
        { name: 'both', kind: ['bin'], src_path: join(PKG_A, 'src', 'bin', 'both.rs') },
        { name: 'dup', kind: ['bin'], src_path: join(PKG_A, 'src', 'bin', 'dup.rs') },
      ],
    },
    {
      name: 'pkg_b',
      manifest_path: join(PKG_B, 'Cargo.toml'),
      dependencies: [{ name: 'bevy' }],
      targets: [
        { name: 'dup', kind: ['bin'], src_path: join(PKG_B, 'src', 'main.rs') },
        { name: 'demo', kind: ['example'], src_path: join(PKG_B, 'examples', 'demo.rs') },
        { name: 'both', kind: ['example'], src_path: join(PKG_B, 'examples', 'both.rs') },
      ],
    },
    {
      // A workspace member without a `bevy` dependency is not a Bevy app —
      // upstream bevy_app_filter keeps it out of the listing entirely.
      name: 'util_pkg',
      manifest_path: join(BASE, 'util_pkg', 'Cargo.toml'),
      dependencies: [{ name: 'serde' }],
      targets: [
        { name: 'util-cli', kind: ['bin'], src_path: join(BASE, 'util_pkg', 'src', 'main.rs') },
      ],
    },
  ],
};

test.after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

interface BuildCall {
  package: string;
  target: string;
  kindFlag: string;
  release: boolean;
}

function fakeCargoRunner(buildCalls: BuildCall[]): CargoRunner {
  return async (_file, args) => {
    if (args[0] === 'metadata') {
      return { stdout: JSON.stringify(METADATA), stderr: '' };
    }
    if (args[0] === 'build') {
      const pkg = args[2]!;
      const kindFlag = args[3]!;
      const target = args[4]!;
      const release = args.includes('--release');
      buildCalls.push({ package: pkg, target, kindFlag, release });
      const artifact = {
        reason: 'compiler-artifact',
        package_id: `path#${pkg}@0.1.0`,
        executable: join(BASE, 'target', release ? 'release' : 'debug', target),
        target: { name: target, kind: [kindFlag === '--bin' ? 'bin' : 'example'] },
      };
      return { stdout: `${JSON.stringify(artifact)}\n`, stderr: '' };
    }
    throw new Error(`unexpected cargo invocation: ${args.join(' ')}`);
  };
}

interface FakeLaunch extends LaunchSpec {
  process: TrackedProcess;
  alive: boolean;
}

class FakeProcesses implements ProcessService {
  launches: FakeLaunch[] = [];
  terminated: TrackedProcess[] = [];
  /** Controls the graceful-shutdown wait: true = exited within the window. */
  waitResult = true;
  /** Launch calls at these 0-based indexes throw instead of spawning. */
  launchErrors = new Map<number, Error>();
  /** When set, terminate rejects and the child stays tracked and alive. */
  terminateError: Error | null = null;

  launch(spec: LaunchSpec): TrackedProcess {
    const launchError = this.launchErrors.get(this.launches.length);
    if (launchError !== undefined) throw launchError;
    const entry = { ...spec, alive: true } as FakeLaunch;
    entry.process = {
      appName: spec.appName,
      pid: 5000 + this.launches.length + 1,
      port: spec.port,
      logPath: spec.logPath,
      exited: Promise.resolve(),
      isAlive: () => entry.alive,
    };
    this.launches.push(entry);
    return entry.process;
  }

  findByApp(appName: string): TrackedProcess[] {
    return this.launches
      .filter((entry) => entry.appName === appName)
      .map((entry) => entry.process);
  }

  async waitForExit(): Promise<boolean> {
    return this.waitResult;
  }

  async terminate(process: TrackedProcess): Promise<void> {
    this.terminated.push(process);
    if (this.terminateError !== null) throw this.terminateError;
    // Match ProcessManager's exit behavior: a terminated child leaves the
    // tracked set and reports not-alive.
    const entry = this.launches.find((candidate) => candidate.process === process);
    if (entry !== undefined) entry.alive = false;
    this.launches = this.launches.filter((candidate) => candidate.process !== process);
  }

  async shutdownAll(): Promise<void> {}
}

class FakeBrp {
  discoverCalls: number[] = [];
  discoverError: Error | null = null;
  shutdownCalls: { method: string; port?: number }[] = [];
  shutdownError: Error | null = null;

  async discover(port?: number): Promise<unknown> {
    this.discoverCalls.push(port!);
    if (this.discoverError) throw this.discoverError;
    return { methods: [] };
  }

  async call(method: string, _params: unknown, options: BrpCallOptions = {}): Promise<unknown> {
    assert.equal(method, 'brp_extras/shutdown', 'shutdown must call the fixed extras method');
    this.shutdownCalls.push({ method, port: options.port });
    if (this.shutdownError) throw this.shutdownError;
    return { success: true, message: 'Shutdown initiated', pid: 9999 };
  }
}

function harness(): {
  cargoBuildCalls: BuildCall[];
  processes: FakeProcesses;
  brp: FakeBrp;
  logStore: LogStore;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
} {
  const cargoBuildCalls: BuildCall[] = [];
  const processes = new FakeProcesses();
  const brp = new FakeBrp();
  const logStore = new LogStore(join(BASE, `logs-${Math.random().toString(36).slice(2)}`));
  const services: BevyMcpServices = {
    brp: brp as unknown as BrpClient,
    cargo: new CargoRuntime(fakeCargoRunner(cargoBuildCalls)),
    catalog: loadToolContractCatalog(),
    logStore,
    watches: {} as BevyMcpServices['watches'],
    processes,
  };
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerAppTools(server, services, loadToolContractCatalog());
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;
  return {
    cargoBuildCalls,
    processes,
    brp,
    logStore,
    call: (name, args = {}) => tools[name]!.handler(args),
  };
}

function envelope(result: CallToolResult): ToolCallJsonResponse {
  return result.structuredContent as ToolCallJsonResponse;
}

interface Item {
  name: string;
  kind: string;
  package_name: string;
  brp_level: string;
  manifest_path: string;
  relative_path: string;
}

test('brp_list_bevy returns cargo-metadata targets with kind and brp_level', async () => {
  const { call } = harness();
  const result = await call('brp_list_bevy', { path: BASE });

  assert.equal(result.isError, undefined);
  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.equal(env.message, 'Found 6 Bevy targets');
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_list_bevy' });
  assert.deepEqual(env.metadata, { count: 6 });

  const items = env.result as Item[];
  // CargoRuntime orders by name, then package, then kind.
  assert.deepEqual(
    items.map((item) => `${item.name}:${item.kind}:${item.package_name}`),
    [
      'both:app:pkg_a',
      'both:example:pkg_b',
      'demo:example:pkg_b',
      'dup:app:pkg_a',
      'dup:app:pkg_b',
      'fixture:app:pkg_a',
    ],
  );
  const levels = Object.fromEntries(
    items.map((item) => [`${item.name}@${item.package_name}`, item.brp_level]),
  );
  assert.equal(levels['fixture@pkg_a'], 'extras', 'BrpExtrasPlugin import detected');
  assert.equal(levels['demo@pkg_b'], 'brp_only', 'RemotePlugin-only import detected');
  assert.equal(levels['dup@pkg_b'], 'none', 'no BRP imports detected');
  // The level comes from each target's own cargo src_path, not a shared
  // guess: pkg_a's secondary bins do not read src/main.rs.
  assert.equal(levels['both@pkg_a'], 'brp_only', 'custom src_path file inspected');
  assert.equal(levels['dup@pkg_a'], 'none', 'custom src_path file inspected');
  assert.equal(levels['util-cli@util_pkg'], undefined, 'non-Bevy package filtered out');
  for (const item of items) {
    assert.ok(item.manifest_path.endsWith('Cargo.toml'));
    assert.equal(typeof item.relative_path, 'string');
  }
});

test('brp_launch builds the selected app once and spawns it referenced', async () => {
  const { call, cargoBuildCalls, processes, logStore } = harness();
  const result = await call('brp_launch', {
    target_name: 'fixture',
    path: BASE,
    port: 15702,
    args: ['--headless'],
  });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.match(env.message, /Successfully launched 1 instance\(s\) of fixture on ports 15702/);
  assert.deepEqual(env.call_info, { mcp_tool: 'brp_launch' });

  // ONE cargo build per selected target/profile, via the artifact seam.
  assert.deepEqual(cargoBuildCalls, [
    { package: 'pkg_a', target: 'fixture', kindFlag: '--bin', release: false },
  ]);

  const launch = processes.launches[0]!;
  assert.equal(launch.executable, join(BASE, 'target', 'debug', 'fixture'));
  assert.deepEqual(launch.args, ['--headless']);
  assert.equal(launch.cwd, PKG_A);
  assert.equal(launch.port, 15702);
  assert.equal(launch.env?.CARGO_MANIFEST_DIR, PKG_A);
  assert.match(launch.logPath, /apps[\\/]bevy-mcp_fixture_\d+\.log$/);

  const metadata = env.metadata as Record<string, unknown>;
  assert.equal(metadata.launched_as, 'app');
  assert.equal(metadata.target_name, 'fixture');
  assert.equal(metadata.profile, 'debug');
  assert.equal(metadata.binary_path, join(BASE, 'target', 'debug', 'fixture'));
  assert.equal(metadata.package_name, undefined);

  const launchResult = env.result as { pid: number; log_file: string; port: number }[];
  assert.equal(launchResult.length, 1);
  assert.equal(launchResult[0]!.pid, launch.process.pid);
  assert.equal(launchResult[0]!.port, 15702);
  assert.equal(launchResult[0]!.log_file, launch.logPath);
  assert.ok(await logStore.read(launchResult[0]!.log_file.split(/[/\\]/).pop()!));
});

test('brp_launch passes example args directly to the artifact (no cargo run)', async () => {
  const { call, cargoBuildCalls, processes } = harness();
  const result = await call('brp_launch', {
    target_name: 'demo',
    path: BASE,
    args: ['--windowed', '1'],
  });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  const metadata = env.metadata as Record<string, unknown>;
  assert.equal(metadata.launched_as, 'example');
  assert.equal(metadata.package_name, 'pkg_b');
  assert.equal(metadata.binary_path, undefined);
  assert.deepEqual(cargoBuildCalls, [
    { package: 'pkg_b', target: 'demo', kindFlag: '--example', release: false },
  ]);
  // The example receives exactly the caller's argv; no `--` separator exists
  // because the owned server executes the artifact directly.
  assert.deepEqual(processes.launches[0]!.args, ['--windowed', '1']);
});

test('brp_launch honours search_order app/example for shared names', async () => {
  const { call } = harness();

  const appFirst = envelope(await call('brp_launch', { target_name: 'both', path: BASE }));
  assert.equal((appFirst.metadata as Record<string, unknown>).launched_as, 'app');
  assert.equal((appFirst.metadata as Record<string, unknown>).package_name, undefined);

  const exampleFirst = envelope(
    await call('brp_launch', { target_name: 'both', path: BASE, search_order: 'example' }),
  );
  assert.equal((exampleFirst.metadata as Record<string, unknown>).launched_as, 'example');
  assert.equal((exampleFirst.metadata as Record<string, unknown>).package_name, 'pkg_b');
});

test('brp_launch rejects ambiguous names with candidate packages; package_name disambiguates', async () => {
  const { call, cargoBuildCalls } = harness();

  const ambiguous = await call('brp_launch', { target_name: 'dup', path: BASE });
  assert.equal(ambiguous.isError, true);
  const env = envelope(ambiguous);
  assert.equal(env.status, 'error');
  assert.match(env.message, /Found multiple apps named `dup`/);
  assert.match(env.message, /package_name/);
  const errorInfo = env.error_info as { available_package_names: string[] };
  assert.deepEqual(errorInfo.available_package_names.sort(), ['pkg_a', 'pkg_b']);
  assert.equal(cargoBuildCalls.length, 0);

  const resolved = envelope(
    await call('brp_launch', { target_name: 'dup', path: BASE, package_name: 'pkg_b' }),
  );
  assert.equal(resolved.status, 'success');
  assert.deepEqual(cargoBuildCalls, [
    { package: 'pkg_b', target: 'dup', kindFlag: '--bin', release: false },
  ]);
});

test('brp_launch not-found errors list available targets', async () => {
  const { call } = harness();
  const result = await call('brp_launch', { target_name: 'nope', path: BASE });
  assert.equal(result.isError, true);
  const env = envelope(result);
  assert.equal(env.message, 'No app or example named `nope` found');
  const errorInfo = env.error_info as {
    target_name: string;
    available_targets: { name: string; kind: string; path: string }[];
  };
  assert.equal(errorInfo.target_name, 'nope');
  assert.equal(errorInfo.available_targets.length, 6);
  assert.ok(errorInfo.available_targets.every((t) => t.kind === 'app' || t.kind === 'example'));
});

test('brp_launch validates ports and consecutive ranges', async () => {
  const { call, cargoBuildCalls, processes } = harness();
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ port: 80 }, /Invalid port 80: must be in range 1024-65534/],
    [{ port: 65535 }, /Invalid port 65535: must be in range 1024-65534/],
    [{ port: 15702.5 }, /Invalid port 15702\.5/],
    [
      { port: 65534, instance_count: 2 },
      /Port range 65534 to 65535 exceeds maximum valid port 65534/,
    ],
    [{ instance_count: 0 }, /Invalid instance count 0: must be in range 1-100/],
    [{ instance_count: 101 }, /Invalid instance count 101: must be in range 1-100/],
    [{ search_order: 'sideways' }, /Invalid search_order 'sideways': must be app or example/],
    [{ profile: 'nightly' }, /Invalid profile 'nightly': must be debug or release/],
  ];
  for (const [args, pattern] of cases) {
    const result = await call('brp_launch', { target_name: 'fixture', path: BASE, ...args });
    assert.equal(result.isError, true, `expected error for ${JSON.stringify(args)}`);
    assert.match(envelope(result).message, pattern);
  }
  assert.equal(cargoBuildCalls.length, 0);
  assert.equal(processes.launches.length, 0);
});

test('brp_launch runs ONE cargo build and spawns instance_count children on consecutive ports', async () => {
  const { call, cargoBuildCalls, processes, logStore } = harness();
  const result = await call('brp_launch', {
    target_name: 'fixture',
    path: BASE,
    port: 15702,
    instance_count: 3,
    profile: 'release',
  });

  const env = envelope(result);
  assert.equal(env.status, 'success');
  assert.match(env.message, /3 instance\(s\) of fixture on ports 15702-15704/);
  assert.equal(cargoBuildCalls.length, 1, 'exactly one cargo build');
  assert.equal(cargoBuildCalls[0]!.release, true);

  const launchResult = env.result as { pid: number; log_file: string; port: number }[];
  assert.deepEqual(
    launchResult.map((instance) => instance.port),
    [15702, 15703, 15704],
  );
  assert.deepEqual(
    processes.launches.map((launch) => launch.port),
    [15702, 15703, 15704],
  );
  const logFiles = launchResult.map((instance) => instance.log_file);
  assert.equal(new Set(logFiles).size, 3, 'each instance gets its own log file');
  const listed = await logStore.list({ appName: 'fixture' });
  assert.equal(listed.length, 3);
});

test('brp_launch rolls back started children when a later launch fails', async () => {
  const { call, processes } = harness();
  processes.launchErrors.set(1, new Error('spawn denied'));

  const env = envelope(
    await call('brp_launch', {
      target_name: 'fixture',
      path: BASE,
      port: 15702,
      instance_count: 2,
    }),
  );

  assert.equal(env.status, 'error');
  assert.equal(env.message, 'spawn denied');
  assert.deepEqual(
    processes.terminated.map((process) => process.pid),
    [5001],
    'the already-started child is terminated',
  );
});

test('brp_launch names possibly-live pids when rollback termination fails', async () => {
  const { call, processes } = harness();
  processes.launchErrors.set(1, new Error('spawn denied'));
  processes.terminateError = new Error('child ignored SIGKILL');

  const env = envelope(
    await call('brp_launch', {
      target_name: 'fixture',
      path: BASE,
      port: 15702,
      instance_count: 2,
    }),
  );

  assert.equal(env.status, 'error');
  assert.match(env.message, /spawn denied/);
  assert.match(env.message, /5001/, 'the surviving child pid is reported');
  assert.match(env.message, /may still be running/);
  assert.deepEqual(processes.terminated.map((process) => process.pid), [5001]);
});

test('brp_status combines tracked state with the rpc.discover readiness probe', async () => {
  const { call, processes, brp } = harness();
  await call('brp_launch', { target_name: 'fixture', path: BASE, port: 15702 });

  const ok = await call('brp_status', { app_name: 'fixture', port: 15702 });
  const okEnv = envelope(ok);
  assert.equal(okEnv.status, 'success');
  assert.deepEqual(okEnv.metadata, { app_name: 'fixture', pid: 5001, port: 15702 });
  assert.match(okEnv.message, /is running with BRP enabled on port 15702/);
  assert.deepEqual(brp.discoverCalls, [15702]);

  // Tracked but BRP not responding.
  brp.discoverError = new BrpError('connect ECONNREFUSED');
  const notResponding = await call('brp_status', { app_name: 'fixture', port: 15702 });
  assert.equal(notResponding.isError, true);
  const notRespondingEnv = envelope(notResponding);
  assert.match(notRespondingEnv.message, /running but not responding to BRP/);
  assert.deepEqual(notRespondingEnv.error_info, { app_name: 'fixture', pid: 5001, port: 15702 });

  // Untracked and not responding.
  const untracked = await call('brp_status', { app_name: 'ghost', port: 15702 });
  assert.equal(untracked.isError, true);
  const untrackedEnv = envelope(untracked);
  assert.match(untrackedEnv.message, /not found and BRP is not responding on port 15702/);
  assert.deepEqual(untrackedEnv.error_info, {
    app_name: 'ghost',
    brp_responding_on_port: false,
    port: 15702,
  });
  assert.deepEqual(processes.launches.map((l) => l.process.pid), [5001]);

  // Untracked while BRP responds (foreign process on the port).
  brp.discoverError = null;
  const foreign = await call('brp_status', { app_name: 'ghost', port: 15702 });
  assert.equal(foreign.isError, true);
  const foreignEnv = envelope(foreign);
  assert.match(foreignEnv.message, /another process may be using it/);
  assert.equal((foreignEnv.error_info as Record<string, unknown>).brp_responding_on_port, true);
});

test('multiple instances: a provided port targets one child, no port is ambiguous', async () => {
  const { call, processes, brp } = harness();
  await call('brp_launch', { target_name: 'fixture', path: BASE, port: 15702 });
  await call('brp_launch', { target_name: 'fixture', path: BASE, port: 15703 });
  assert.equal(processes.findByApp('fixture').length, 2);

  // brp_status with a port: only that instance (name AND port match).
  const scoped = await call('brp_status', { app_name: 'fixture', port: 15703 });
  const scopedEnv = envelope(scoped);
  assert.equal(scopedEnv.status, 'success');
  assert.deepEqual(scopedEnv.metadata, { app_name: 'fixture', pid: 5002, port: 15703 });

  // brp_status without a port: ambiguity error listing every instance.
  const ambiguous = await call('brp_status', { app_name: 'fixture' });
  assert.equal(ambiguous.isError, true);
  const ambiguousEnv = envelope(ambiguous);
  assert.match(ambiguousEnv.message, /Multiple running instances of 'fixture'/);
  assert.match(ambiguousEnv.message, /ports 15702, 15703/);
  assert.match(ambiguousEnv.message, /Specify 'port'/);
  assert.deepEqual(ambiguousEnv.error_info, {
    app_name: 'fixture',
    instances: [
      { pid: 5001, port: 15702 },
      { pid: 5002, port: 15703 },
    ],
  });

  // brp_shutdown without a port while both instances are alive: ambiguity
  // error before any BRP traffic.
  brp.shutdownCalls.length = 0;
  const ambiguousShutdown = await call('brp_shutdown', { app_name: 'fixture' });
  assert.equal(ambiguousShutdown.isError, true);
  assert.match(envelope(ambiguousShutdown).message, /Multiple running instances of 'fixture'/);
  assert.deepEqual(brp.shutdownCalls, [], 'no graceful call before disambiguation');
  assert.equal(processes.terminated.length, 0, 'no termination yet');

  // brp_shutdown with a port: only that child is terminated.
  brp.shutdownError = new BrpError('connect ECONNREFUSED');
  const scopedShutdown = await call('brp_shutdown', { app_name: 'fixture', port: 15702 });
  const scopedShutdownEnv = envelope(scopedShutdown);
  assert.equal(scopedShutdownEnv.status, 'success');
  assert.equal((scopedShutdownEnv.metadata as Record<string, unknown>).pid, 5001);
  assert.equal(
    (scopedShutdownEnv.metadata as Record<string, unknown>).shutdown_method,
    'process_kill',
  );
  assert.deepEqual(processes.terminated.map((process) => process.pid), [5001]);

  // After the 15702 instance exited, only the 15703 child remains: a no-port
  // shutdown now selects it unambiguously, targeting ITS port (not 15702).
  brp.shutdownCalls.length = 0;
  const remaining = await call('brp_shutdown', { app_name: 'fixture' });
  const remainingEnv = envelope(remaining);
  assert.equal(remainingEnv.status, 'success');
  const remainingMetadata = remainingEnv.metadata as Record<string, unknown>;
  assert.equal(remainingMetadata.pid, 5002);
  assert.equal(remainingMetadata.port, 15703);
  assert.equal(remainingMetadata.shutdown_method, 'process_kill');
  assert.deepEqual(brp.shutdownCalls, [{ method: 'brp_extras/shutdown', port: 15703 }]);
  assert.deepEqual(processes.terminated.map((process) => process.pid), [5001, 5002]);
});

test('brp_shutdown reports graceful shutdown and falls back to termination', async () => {
  const { call, processes, brp } = harness();
  await call('brp_launch', { target_name: 'fixture', path: BASE, port: 15702 });

  // Graceful: extras answers and the child exits within the bounded window.
  const graceful = await call('brp_shutdown', { app_name: 'fixture', port: 15702 });
  const gracefulEnv = envelope(graceful);
  assert.equal(gracefulEnv.status, 'success');
  assert.deepEqual(brp.shutdownCalls, [{ method: 'brp_extras/shutdown', port: 15702 }]);
  const gracefulMetadata = gracefulEnv.metadata as Record<string, unknown>;
  assert.equal(gracefulMetadata.shutdown_method, 'clean_shutdown');
  assert.equal(gracefulMetadata.pid, 5001);
  assert.equal(gracefulMetadata.app_name, 'fixture');
  assert.equal(gracefulMetadata.warning, undefined);
  assert.deepEqual(processes.terminated, []);

  // Graceful call succeeds but the child stays alive past the window.
  processes.waitResult = false;
  const timedOut = await call('brp_shutdown', { app_name: 'fixture', port: 15702 });
  const timedOutEnv = envelope(timedOut);
  assert.equal((timedOutEnv.metadata as Record<string, unknown>).shutdown_method, 'process_kill');
  assert.deepEqual(processes.terminated.length, 1);
  assert.match(
    (timedOutEnv.metadata as Record<string, unknown>).warning as string,
    /bevy_brp_extras/,
  );
});

test('brp_shutdown terminates on BRP failure and errors when nothing is running', async () => {
  const { call, processes, brp } = harness();

  // BRP not responding but a tracked child exists -> terminate it.
  await call('brp_launch', { target_name: 'fixture', path: BASE, port: 15702 });
  brp.shutdownError = new BrpError('connect ECONNREFUSED');
  const fallback = await call('brp_shutdown', { app_name: 'fixture', port: 15702 });
  const fallbackEnv = envelope(fallback);
  assert.equal(fallbackEnv.status, 'success');
  assert.equal((fallbackEnv.metadata as Record<string, unknown>).shutdown_method, 'process_kill');
  assert.equal((fallbackEnv.metadata as Record<string, unknown>).pid, 5001);
  assert.equal(processes.terminated.length, 1);

  // Nothing tracked and BRP dead -> upstream-compatible not-running error.
  const notRunning = await call('brp_shutdown', { app_name: 'ghost', port: 15702 });
  assert.equal(notRunning.isError, true);
  const notRunningEnv = envelope(notRunning);
  assert.equal(notRunningEnv.message, "Process 'ghost' is not currently running");
  assert.deepEqual(notRunningEnv.error_info, { app_name: 'ghost' });
});
