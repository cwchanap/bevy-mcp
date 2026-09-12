import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import { CargoRuntime, computeRelativePath, packageNameFromPackageId, normalizeCargoMetadata, selectExecutableArtifact, type BevyTarget, type CargoRunner } from '../src/runtime/cargo.js';

// ===== Unit fixtures (pure JSON parsing through the runner seam) =====

const FIXTURE_METADATA = JSON.stringify({
  packages: [
    {
      name: 'zeta-app',
      manifest_path: '/ws/zeta/Cargo.toml',
      dependencies: [{ name: 'bevy' }],
      targets: [
        { name: 'zeta-app', kind: ['bin'], src_path: '/ws/zeta/src/main.rs' },
        { name: 'unused-lib', kind: ['lib'], src_path: '/ws/zeta/src/lib.rs' },
      ],
    },
    {
      name: 'alpha-pkg',
      manifest_path: '/ws/alpha/Cargo.toml',
      dependencies: [{ name: 'bevy' }],
      targets: [
        // Duplicate target name across packages, plus same-name bin+example.
        { name: 'alpha-pkg', kind: ['bin'], src_path: '/ws/alpha/src/main.rs' },
        { name: 'demo', kind: ['example'], src_path: '/ws/alpha/examples/demo.rs' },
        { name: 'shared', kind: ['bin'], src_path: '/ws/alpha/src/bin/shared.rs' },
        { name: 'shared', kind: ['example'], src_path: '/ws/alpha/examples/shared.rs' },
      ],
    },
    {
      name: 'beta-pkg',
      manifest_path: '/ws/beta/Cargo.toml',
      dependencies: [{ name: 'bevy' }],
      targets: [{ name: 'shared', kind: ['bin'], src_path: '/ws/beta/src/bin/shared.rs' }],
    },
    {
      // A workspace member without a `bevy` dependency is not a Bevy app —
      // its bins must never surface (upstream bevy_app_filter).
      name: 'util-pkg',
      manifest_path: '/ws/util/Cargo.toml',
      dependencies: [{ name: 'serde' }],
      targets: [{ name: 'util-cli', kind: ['bin'], src_path: '/ws/util/src/main.rs' }],
    },
  ],
});

const expectedTarget = (
  name: string,
  kind: 'app' | 'example',
  packageName: string,
  manifestPath: string,
  srcPath: string,
): BevyTarget => ({
  name,
  kind,
  packageName,
  manifestPath,
  workspaceRoot: '',
  packageRoot: manifestPath.slice(0, manifestPath.lastIndexOf('/')),
  srcPath,
});

test('metadata normalization keeps only executable targets of Bevy packages and maps kinds', () => {
  const targets = normalizeCargoMetadata(FIXTURE_METADATA);
  assert.deepEqual(targets, [
    expectedTarget('alpha-pkg', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/src/main.rs'),
    expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/examples/demo.rs'),
    expectedTarget('shared', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/src/bin/shared.rs'),
    expectedTarget('shared', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/examples/shared.rs'),
    expectedTarget('shared', 'app', 'beta-pkg', '/ws/beta/Cargo.toml', '/ws/beta/src/bin/shared.rs'),
    expectedTarget('zeta-app', 'app', 'zeta-app', '/ws/zeta/Cargo.toml', '/ws/zeta/src/main.rs'),
  ]);
});

test('metadata normalization filters non-Bevy workspace members and bevy_brp_mcp itself', () => {
  const metadata = JSON.stringify({
    packages: [
      {
        name: 'util-pkg',
        manifest_path: '/ws/util/Cargo.toml',
        dependencies: [{ name: 'serde' }],
        targets: [{ name: 'util-cli', kind: ['bin'], src_path: '/ws/util/src/main.rs' }],
      },
      {
        name: 'no-deps-member',
        manifest_path: '/ws/nd/Cargo.toml',
        targets: [{ name: 'nd-cli', kind: ['bin'], src_path: '/ws/nd/src/main.rs' }],
      },
      {
        name: 'bevy_brp_mcp',
        manifest_path: '/ws/mcp/Cargo.toml',
        dependencies: [{ name: 'bevy' }],
        targets: [{ name: 'bevy_brp_mcp', kind: ['bin'], src_path: '/ws/mcp/src/main.rs' }],
      },
      {
        // The bevy crate itself is included (its examples are discoverable).
        name: 'bevy',
        manifest_path: '/ws/bevy/Cargo.toml',
        targets: [{ name: 'breakout', kind: ['example'], src_path: '/ws/bevy/examples/breakout.rs' }],
      },
    ],
  });
  assert.deepEqual(normalizeCargoMetadata(metadata), [
    expectedTarget('breakout', 'example', 'bevy', '/ws/bevy/Cargo.toml', '/ws/bevy/examples/breakout.rs'),
  ]);
});

test('normalization ordering is deterministic across runs', () => {
  const once = normalizeCargoMetadata(FIXTURE_METADATA);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(normalizeCargoMetadata(FIXTURE_METADATA), once);
  }
});

/** Fake runner keyed off args[0]: 'metadata' → fixture JSON, 'build' →
 * recorded args + fixture artifact stream(s, popped in order). */
function makeFakeRunner(buildOutput: string | string[] | Error) {
  const outputs = Array.isArray(buildOutput) ? [...buildOutput] : buildOutput;
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner: CargoRunner = async (_file, args, options) => {
    calls.push({ args: [...args], cwd: options?.cwd });
    if (args[0] === 'metadata') {
      return { stdout: FIXTURE_METADATA, stderr: '' };
    }
    const output = Array.isArray(outputs) ? outputs.shift() : outputs;
    if (output instanceof Error) throw output;
    return { stdout: output ?? '', stderr: '' };
  };
  return { runner, calls };
}

// ===== Discovery fixtures (real directories — the shallow scan is real fs) =====

const TMP_ROOTS: string[] = [];
function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bevy-mcp-cargo-'));
  TMP_ROOTS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function writeManifest(dir: string, contents = '[package]\nname = "x"\nversion = "0.1.0"\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), contents);
}

interface PkgSpec {
  name: string;
  dir: string;
  deps?: string[];
  targets?: { name: string; kind: string[]; src?: string }[];
}

/** `cargo metadata --no-deps` body for a workspace rooted at `wsRoot`. */
function metadataJson(wsRoot: string, packages: PkgSpec[]): string {
  return JSON.stringify({
    workspace_root: wsRoot,
    packages: packages.map((pkg) => ({
      name: pkg.name,
      manifest_path: join(pkg.dir, 'Cargo.toml'),
      dependencies: (pkg.deps ?? ['bevy']).map((name) => ({ name })),
      targets: (pkg.targets ?? []).map((target) => ({
        name: target.name,
        kind: target.kind,
        src_path: target.src ?? join(pkg.dir, 'src', 'main.rs'),
      })),
    })),
  });
}

/** Runner keyed by cwd: 'metadata' returns the mapped stdout (empty package
 * set for unmapped dirs, or throws a mapped Error); 'build' behaves like
 * makeFakeRunner. */
function makeDirRunner(
  byDir: Map<string, string | Error>,
  buildOutput: string | string[] | Error = '',
) {
  const outputs = Array.isArray(buildOutput) ? [...buildOutput] : buildOutput;
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner: CargoRunner = async (_file, args, options) => {
    const cwd = options?.cwd ?? '';
    calls.push({ args: [...args], cwd });
    if (args[0] === 'metadata') {
      const out = byDir.get(cwd);
      if (out instanceof Error) throw out;
      return {
        stdout: out ?? JSON.stringify({ workspace_root: cwd, packages: [] }),
        stderr: '',
      };
    }
    const output = Array.isArray(outputs) ? outputs.shift() : outputs;
    if (output instanceof Error) throw output;
    return { stdout: output ?? '', stderr: '' };
  };
  return { runner, calls };
}

test('listTargets runs cargo metadata through the seam and resolves the manifest dir', async () => {
  const alpha = join(makeTmpRoot(), 'alpha');
  writeManifest(alpha);
  const alphaMeta = metadataJson(alpha, [
    {
      name: 'alpha-pkg',
      dir: alpha,
      targets: [
        { name: 'alpha-pkg', kind: ['bin'] },
        { name: 'demo', kind: ['example'], src: join(alpha, 'examples', 'demo.rs') },
        { name: 'shared', kind: ['bin'], src: join(alpha, 'src', 'bin', 'shared.rs') },
        { name: 'shared', kind: ['example'], src: join(alpha, 'examples', 'shared.rs') },
      ],
    },
  ]);
  const { runner, calls } = makeDirRunner(new Map([[alpha, alphaMeta]]));
  const cargo = new CargoRuntime(runner);
  const targets = await cargo.listTargets(join(alpha, 'Cargo.toml'));
  assert.equal(calls[0]!.args.join(' '), 'metadata --format-version 1 --no-deps');
  assert.equal(calls[0]!.cwd, alpha);
  assert.equal(targets.length, 4);

  // Default root = cwd; the implicit cwd search is unfiltered (upstream parity).
  const { runner: cwdRunner, calls: cwdCalls } = makeDirRunner(
    new Map([[process.cwd(), FIXTURE_METADATA]]),
  );
  const unscoped = await new CargoRuntime(cwdRunner).listTargets();
  assert.equal(cwdCalls[0]!.cwd, process.cwd());
  assert.equal(unscoped.length, 6);
});

test('listTargets scopes results to the caller-supplied root inside a workspace', async () => {
  const ws = makeTmpRoot();
  const alpha = join(ws, 'alpha');
  const beta = join(ws, 'beta');
  const util = join(ws, 'util');
  writeManifest(ws, '[workspace]\nmembers = ["alpha", "beta", "util"]\nresolver = "2"\n');
  writeManifest(alpha);
  writeManifest(beta);
  writeManifest(util);
  // Real `cargo metadata` at a member dir resolves the whole workspace.
  const wsMeta = metadataJson(ws, [
    {
      name: 'alpha-pkg',
      dir: alpha,
      targets: [
        { name: 'alpha-pkg', kind: ['bin'] },
        { name: 'demo', kind: ['example'], src: join(alpha, 'examples', 'demo.rs') },
        { name: 'shared', kind: ['bin'], src: join(alpha, 'src', 'bin', 'shared.rs') },
        { name: 'shared', kind: ['example'], src: join(alpha, 'examples', 'shared.rs') },
      ],
    },
    { name: 'beta-pkg', dir: beta, targets: [{ name: 'shared', kind: ['bin'] }] },
    { name: 'util-pkg', dir: util, deps: ['serde'], targets: [{ name: 'util-cli', kind: ['bin'] }] },
  ]);
  const { runner } = makeDirRunner(
    new Map<string, string | Error>([
      [ws, wsMeta],
      [alpha, wsMeta],
      [beta, wsMeta],
    ]),
  );
  const cargo = new CargoRuntime(runner);

  // cargo metadata expands a member dir to the WHOLE workspace; the returned
  // targets must be filtered back under the requested root so a member path
  // cannot expose (or launch) sibling-member targets.
  const alphaOnly = await cargo.listTargets(alpha);
  assert.deepEqual(
    alphaOnly.map((t) => `${t.packageName}/${t.name}/${t.kind}`),
    [
      'alpha-pkg/alpha-pkg/app',
      'alpha-pkg/demo/example',
      'alpha-pkg/shared/app',
      'alpha-pkg/shared/example',
    ],
  );

  const betaOnly = await cargo.listTargets(join(beta, 'Cargo.toml'));
  assert.deepEqual(
    betaOnly.map((t) => `${t.packageName}/${t.name}`),
    ['beta-pkg/shared'],
  );

  // The workspace root still covers every member; an unrelated root is empty.
  assert.equal((await cargo.listTargets(ws)).length, 5);
  assert.deepEqual(await cargo.listTargets(join(ws, 'elsewhere')), []);
});

test("listTargets discovers Cargo projects in a manifestless root's immediate children", async () => {
  // Upstream iter_cargo_project_paths: a search root without Cargo.toml is
  // scanned one level deep for child projects (hidden/`target` dirs skipped).
  const group = makeTmpRoot();
  const one = join(group, 'one');
  const two = join(group, 'two');
  const hidden = join(group, '.hidden');
  const targetDir = join(group, 'target');
  const notCargo = join(group, 'not-cargo');
  writeManifest(one);
  writeManifest(two);
  writeManifest(hidden);
  writeManifest(targetDir);
  mkdirSync(notCargo, { recursive: true });
  const pkg = (dir: string, name: string): [string, string] => [
    dir,
    metadataJson(dir, [{ name: `${name}-pkg`, dir, targets: [{ name: `${name}-app`, kind: ['bin'] }] }]),
  ];
  const { runner, calls } = makeDirRunner(
    new Map<string, string | Error>([
      pkg(one, 'one'),
      pkg(two, 'two'),
      pkg(hidden, 'hidden'),
      pkg(targetDir, 'target'),
    ]),
  );
  const cargo = new CargoRuntime(runner);

  const targets = await cargo.listTargets(group);
  assert.deepEqual(
    targets.map((t) => t.name),
    ['one-app', 'two-app'],
  );
  assert.deepEqual(
    [...new Set(calls.map((call) => call.cwd))].sort(),
    [one, two].sort(),
    'metadata runs per discovered child project, never at the root or skipped dirs',
  );
});

test('listTargets still scans children under a standalone or member root', async () => {
  // Upstream: only a multi-member workspace ROOT suppresses the child scan —
  // a standalone package's own manifest does not hide nested projects.
  const root = makeTmpRoot();
  writeManifest(root);
  const child = join(root, 'child');
  writeManifest(child);
  const { runner } = makeDirRunner(
    new Map<string, string | Error>([
      [root, metadataJson(root, [{ name: 'root-pkg', dir: root, targets: [{ name: 'root-app', kind: ['bin'] }] }])],
      [child, metadataJson(child, [{ name: 'child-pkg', dir: child, targets: [{ name: 'child-app', kind: ['bin'] }] }])],
    ]),
  );
  const cargo = new CargoRuntime(runner);
  assert.deepEqual(
    (await cargo.listTargets(root)).map((t) => t.name),
    ['child-app', 'root-app'],
  );
});

test('listTargets skips the child scan for a multi-member workspace root', async () => {
  const ws = makeTmpRoot();
  writeManifest(ws, '[workspace]\nmembers = ["alpha", "beta"]\nresolver = "2"\n');
  const alpha = join(ws, 'alpha');
  const beta = join(ws, 'beta');
  const stray = join(ws, 'stray');
  writeManifest(alpha);
  writeManifest(beta);
  writeManifest(stray); // excluded from the workspace on disk
  const wsMeta = metadataJson(ws, [
    { name: 'alpha-pkg', dir: alpha, targets: [{ name: 'alpha-app', kind: ['bin'] }] },
    { name: 'beta-pkg', dir: beta, targets: [{ name: 'beta-app', kind: ['bin'] }] },
  ]);
  const { runner, calls } = makeDirRunner(
    new Map<string, string | Error>([
      [ws, wsMeta],
      [stray, metadataJson(stray, [{ name: 'stray-pkg', dir: stray, targets: [{ name: 'stray-app', kind: ['bin'] }] }])],
    ]),
  );
  const cargo = new CargoRuntime(runner);

  assert.deepEqual(
    (await cargo.listTargets(ws)).map((t) => t.name),
    ['alpha-app', 'beta-app'],
  );
  assert.ok(
    !calls.some((call) => call.cwd === stray),
    'a non-member child crate under a multi-member workspace root is never scanned',
  );
});

test('listTargets skips projects whose metadata Cargo cannot produce', async () => {
  const root = makeTmpRoot();
  writeManifest(root, 'this is not valid toml [');
  const child = join(root, 'child');
  writeManifest(child);
  const { runner } = makeDirRunner(
    new Map<string, string | Error>([
      [root, new Error('cargo metadata failed')],
      [child, metadataJson(child, [{ name: 'child-pkg', dir: child, targets: [{ name: 'child-app', kind: ['bin'] }] }])],
    ]),
  );
  const cargo = new CargoRuntime(runner);
  // Upstream never fails the listing on a broken manifest: the project is
  // recorded as a standalone candidate, then skipped when metadata fails.
  assert.deepEqual(
    (await cargo.listTargets(root)).map((t) => t.name),
    ['child-app'],
  );
});

test('computeRelativePath mirrors the upstream search-root rules', () => {
  const base = makeTmpRoot();
  const pkg = join(base, 'pkg');
  mkdirSync(pkg);
  assert.equal(computeRelativePath(pkg, base), 'pkg');
  // A path equal to the root reports its own directory name (upstream
  // compute_relative_path falls back to the canonical file name).
  assert.equal(computeRelativePath(base, base), basename(base));
  // Outside the root the original path is kept.
  const outside = join(base, '..', 'outside-proj');
  assert.equal(computeRelativePath(outside, base), outside);
});

const BUILD_OUTPUT = [
  JSON.stringify({ reason: 'build-finished', debug: true }),
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: 'path+file:///ws/alpha#alpha-pkg@0.1.0',
    target: { name: 'demo', kind: ['example'] },
    executable: null,
  }),
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: 'path+file:///ws/beta#beta-pkg@0.2.0',
    target: { name: 'shared', kind: ['bin'] },
    executable: '/ws/target/debug/shared',
  }),
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: 'path+file:///ws/alpha#alpha-pkg@0.1.0',
    target: { name: 'demo', kind: ['example'] },
    executable: '/ws/target/debug/examples/demo',
  }),
  'warning: unused variable (rendered diagnostics, not JSON)',
  '',
].join('\n');

test('artifact selection matches the exact package+target and requires non-null executable', () => {
  const executable = selectExecutableArtifact(BUILD_OUTPUT, 'alpha-pkg', 'demo', 'example');
  assert.equal(executable, '/ws/target/debug/examples/demo');
});

test('artifact selection rejects when no executable artifact matches', () => {
  assert.throws(
    () => selectExecutableArtifact(BUILD_OUTPUT, 'alpha-pkg', 'missing', 'app'),
    /no executable artifact/,
  );
});

test('build passes scoped args, release flag only when requested, cwd = package root', async () => {
  const appBuildOutput = [
    JSON.stringify({
      reason: 'compiler-artifact',
      package_id: 'path+file:///ws/alpha#alpha-pkg@0.1.0',
      target: { name: 'alpha-pkg', kind: ['bin'] },
      executable: '/ws/target/release/alpha-pkg',
    }),
  ].join('\n');
  const { runner, calls } = makeFakeRunner([BUILD_OUTPUT, appBuildOutput]);
  const cargo = new CargoRuntime(runner);
  const target = expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/examples/demo.rs');

  const debug = await cargo.build(target, 'debug');
  assert.equal(debug.executable, '/ws/target/debug/examples/demo');
  assert.deepEqual(calls[0].args, [
    'build',
    '-p',
    'alpha-pkg',
    '--example',
    'demo',
    '--message-format=json-render-diagnostics',
  ]);
  assert.equal(calls[0].cwd, '/ws/alpha');

  const app = expectedTarget('alpha-pkg', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/src/main.rs');
  const release = await cargo.build(app, 'release');
  assert.equal(release.executable, '/ws/target/release/alpha-pkg');
  assert.deepEqual(calls[1].args, [
    'build',
    '-p',
    'alpha-pkg',
    '--bin',
    'alpha-pkg',
    '--message-format=json-render-diagnostics',
    '--release',
  ]);
});

test('build propagates cargo failures', async () => {
  const { runner } = makeFakeRunner(new Error('exit code 101'));
  const cargo = new CargoRuntime(runner);
  await assert.rejects(
    cargo.build(expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml', '/ws/alpha/examples/demo.rs'), 'debug'),
    /exit code 101/,
  );
});

test('package id name extraction', () => {
  assert.equal(packageNameFromPackageId('path+file:///ws/alpha#alpha-pkg@0.1.0'), 'alpha-pkg');
  assert.equal(packageNameFromPackageId('registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0'), 'serde');
});

// ===== Real workspace smoke (gated on being able to build the fixture) =====

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)); // compiled to .test-build/test/

// Building the fixture needs cargo AND the Bevy system deps (wayland, alsa,
// udev…). Environments without them (CI's `node_package` job) opt out via
// BEVY_MCP_SKIP_FIXTURE_TESTS=1 — same contract as type-guides-parity.test.ts.
// The integration job exercises this code path for real through brp_launch.
function smokeSkipReason(): string | false {
  if (process.env.BEVY_MCP_SKIP_FIXTURE_TESTS === '1') return 'fixture build opted out (BEVY_MCP_SKIP_FIXTURE_TESTS=1)';
  try {
    const result = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
    return result.error ? 'cargo not available' : false;
  } catch {
    return 'cargo not available';
  }
}

test('real workspace: discovery finds bevy-mcp-fixture and debug build resolves it', { skip: smokeSkipReason() }, async () => {
  const cargo = new CargoRuntime();
  const targets = await cargo.listTargets(REPO_ROOT);
  const fixture = targets.find((t) => t.name === 'bevy-mcp-fixture');
  assert.ok(fixture, `bevy-mcp-fixture not found among: ${targets.map((t) => `${t.name}(${t.kind})`).join(', ')}`);
  assert.equal(fixture.kind, 'app');
  assert.equal(fixture.packageName, 'bevy-mcp-fixture');

  const { executable } = await cargo.build(fixture, 'debug');
  assert.ok(existsSync(executable), `built executable missing: ${executable}`);
});
