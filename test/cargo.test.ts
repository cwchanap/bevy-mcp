import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CargoRuntime, packageNameFromPackageId, normalizeCargoMetadata, selectExecutableArtifact, type BevyTarget, type CargoRunner } from '../src/runtime/cargo.js';

// ===== Unit fixtures (pure JSON parsing through the runner seam) =====

const FIXTURE_METADATA = JSON.stringify({
  packages: [
    {
      name: 'zeta-app',
      manifest_path: '/ws/zeta/Cargo.toml',
      targets: [
        { name: 'zeta-app', kind: ['bin'] },
        { name: 'unused-lib', kind: ['lib'] },
      ],
    },
    {
      name: 'alpha-pkg',
      manifest_path: '/ws/alpha/Cargo.toml',
      targets: [
        // Duplicate target name across packages, plus same-name bin+example.
        { name: 'alpha-pkg', kind: ['bin'] },
        { name: 'demo', kind: ['example'] },
        { name: 'shared', kind: ['bin'] },
        { name: 'shared', kind: ['example'] },
      ],
    },
    {
      name: 'beta-pkg',
      manifest_path: '/ws/beta/Cargo.toml',
      targets: [{ name: 'shared', kind: ['bin'] }],
    },
  ],
});

const expectedTarget = (
  name: string,
  kind: 'app' | 'example',
  packageName: string,
  manifestPath: string,
): BevyTarget => ({
  name,
  kind,
  packageName,
  manifestPath,
  workspaceRoot: '',
  packageRoot: manifestPath.slice(0, manifestPath.lastIndexOf('/')),
});

test('metadata normalization keeps only executable targets and maps kinds', () => {
  const targets = normalizeCargoMetadata(FIXTURE_METADATA);
  assert.deepEqual(targets, [
    expectedTarget('alpha-pkg', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml'),
    expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml'),
    expectedTarget('shared', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml'),
    expectedTarget('shared', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml'),
    expectedTarget('shared', 'app', 'beta-pkg', '/ws/beta/Cargo.toml'),
    expectedTarget('zeta-app', 'app', 'zeta-app', '/ws/zeta/Cargo.toml'),
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

test('listTargets runs cargo metadata through the seam and resolves the manifest dir', async () => {
  const { runner, calls } = makeFakeRunner('');
  const cargo = new CargoRuntime(runner);
  const targets = await cargo.listTargets('/ws/alpha/Cargo.toml');
  assert.equal(calls[0].args.join(' '), 'metadata --format-version 1 --no-deps');
  assert.equal(calls[0].cwd, '/ws/alpha');
  assert.equal(targets.length, 6);
  // Default root = cwd.
  await cargo.listTargets();
  assert.equal(calls[1].cwd, process.cwd());
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
  const target = expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml');

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

  const app = expectedTarget('alpha-pkg', 'app', 'alpha-pkg', '/ws/alpha/Cargo.toml');
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
    cargo.build(expectedTarget('demo', 'example', 'alpha-pkg', '/ws/alpha/Cargo.toml'), 'debug'),
    /exit code 101/,
  );
});

test('package id name extraction', () => {
  assert.equal(packageNameFromPackageId('path+file:///ws/alpha#alpha-pkg@0.1.0'), 'alpha-pkg');
  assert.equal(packageNameFromPackageId('registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0'), 'serde');
});

// ===== Real workspace smoke (gated on cargo being available) =====

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)); // compiled to .test-build/test/

function cargoMissingReason(): string | false {
  try {
    const result = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
    return result.error ? 'cargo not available' : false;
  } catch {
    return 'cargo not available';
  }
}

test('real workspace: discovery finds bevy-mcp-fixture and debug build resolves it', { skip: cargoMissingReason() }, async () => {
  const cargo = new CargoRuntime();
  const targets = await cargo.listTargets(REPO_ROOT);
  const fixture = targets.find((t) => t.name === 'bevy-mcp-fixture');
  assert.ok(fixture, `bevy-mcp-fixture not found among: ${targets.map((t) => `${t.name}(${t.kind})`).join(', ')}`);
  assert.equal(fixture.kind, 'app');
  assert.equal(fixture.packageName, 'bevy-mcp-fixture');

  const { executable } = await cargo.build(fixture, 'debug');
  assert.ok(existsSync(executable), `built executable missing: ${executable}`);
});
