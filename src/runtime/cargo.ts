import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, resolve } from 'node:path';

/**
 * Repository-owned Cargo runtime: Bevy target discovery via
 * `cargo metadata --format-version 1 --no-deps` and build artifact
 * resolution via `cargo build --message-format=json-render-diagnostics`.
 *
 * The executable path always comes from the compiler-artifact message —
 * `target/` paths are never predicted and no freshness checks exist; Cargo's
 * incremental compilation IS the freshness logic (per the approved design,
 * superseding upstream `bevy_brp_mcp` 0.22.3's predicted-path + mtime
 * freshness scheme, MIT, see THIRD_PARTY_NOTICES.md).
 */

/** One executable Cargo target discovered in a workspace. Internal type;
 * `brp_list_bevy` (task 10) maps these 1:1 onto its name/kind/package_name
 * result fields. */
export interface BevyTarget {
  name: string;
  kind: 'app' | 'example';
  packageName: string;
  manifestPath: string;
  packageRoot: string;
  /** The target's own source file from cargo metadata `src_path` — custom
   * `[[bin]] path` / `[[example]] path` layouts included (upstream
   * `BevyTarget.source`, MIT). */
  srcPath: string;
  /** Cargo workspace root containing the target (upstream launch metadata). */
  workspaceRoot: string;
}

/** Async seam over process execution so tests fake cargo without shelling
 * out (async process execution stays injectable). */
export type CargoRunner = (
  file: string,
  args: readonly string[],
  options: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: CargoRunner = (file, args, options) =>
  execFileP(file, [...args], options);

interface CargoMetadataPackage {
  name: string;
  manifest_path: string;
  /** `dependencies` stays populated under `--no-deps` (only the resolve
   * graph is omitted). */
  dependencies?: { name?: string }[];
  targets: { name: string; kind: string[]; src_path: string }[];
}

interface CargoMetadata {
  workspace_root?: string;
  packages?: CargoMetadataPackage[];
}

interface CargoArtifactMessage {
  reason?: string;
  package_id?: string;
  executable?: string | null;
  target?: { name?: string; kind?: string[] };
}

/** Directory containing the manifest that scopes a `cargo` invocation:
 * accept either a directory or a path to a `Cargo.toml`. */
function resolveManifestDir(root: string): string {
  const resolved = resolve(root);
  return basename(resolved) === 'Cargo.toml' ? dirname(resolved) : resolved;
}

/** Upstream crate-name constants (`app_tools/targets/constants.rs`, MIT). */
const BEVY_CRATE_NAME = 'bevy';
const MCP_CRATE_NAME = 'bevy_brp_mcp';

/** Upstream `bevy_app_filter` (MIT): the `bevy` package itself — its examples
 * are discoverable — or any package with a direct `bevy` dependency. The
 * `bevy_brp_mcp` package itself is always excluded. With `--no-deps` the
 * package list is already scoped to workspace members, but not every member
 * is a Bevy app — this filter is what keeps unrelated utility binaries out
 * of `brp_list_bevy`/`brp_launch`. */
function isBevyPackage(pkg: CargoMetadataPackage): boolean {
  return (
    pkg.name !== MCP_CRATE_NAME &&
    (pkg.name === BEVY_CRATE_NAME ||
      (pkg.dependencies ?? []).some((dep) => dep.name === BEVY_CRATE_NAME))
  );
}

/** Normalize `cargo metadata --format-version 1 --no-deps` output into
 * executable targets (bins → `app`, examples → `example`) of Bevy packages
 * only, sorted by name, then package, then kind. */
export function normalizeCargoMetadata(stdout: string): BevyTarget[] {
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const workspaceRoot = metadata.workspace_root ?? '';
  const targets: BevyTarget[] = [];
  for (const pkg of metadata.packages ?? []) {
    if (!isBevyPackage(pkg)) continue;
    for (const target of pkg.targets) {
      const kind = target.kind.includes('bin')
        ? ('app' as const)
        : target.kind.includes('example')
          ? ('example' as const)
          : undefined;
      if (!kind) continue;
      const manifestPath = pkg.manifest_path;
      targets.push({
        name: target.name,
        kind,
        packageName: pkg.name,
        manifestPath,
        packageRoot: dirname(manifestPath),
        srcPath: target.src_path,
        workspaceRoot,
      });
    }
  }
  return targets.sort(
    (a, b) =>
      compareStrings(a.name, b.name) ||
      compareStrings(a.packageName, b.packageName) ||
      compareStrings(a.kind, b.kind),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Extract the package name from a Cargo package id spec
 * (`<repo>+<url>#<name>@<version>`). */
export function packageNameFromPackageId(packageId: string): string {
  const hash = packageId.lastIndexOf('#');
  const at = packageId.lastIndexOf('@');
  return hash >= 0 && at > hash ? packageId.slice(hash + 1, at) : packageId;
}

/** Scan newline-delimited `cargo build --message-format=json-render-diagnostics`
 * output for the compiler-artifact message of the EXACT package + target
 * (package id name AND target name AND kind) and require its non-null
 * `executable`. Duplicate target names across packages therefore cannot
 * cross-match. */
export function selectExecutableArtifact(
  buildOutput: string,
  packageName: string,
  name: string,
  kind: 'app' | 'example',
): string {
  const wantKind = kind === 'app' ? 'bin' : 'example';
  for (const line of buildOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: CargoArtifactMessage;
    try {
      message = JSON.parse(trimmed) as CargoArtifactMessage;
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact') continue;
    if (message.executable == null) continue;
    if (message.target?.name !== name) continue;
    if (!message.target.kind?.includes(wantKind)) continue;
    if (packageNameFromPackageId(message.package_id ?? '') !== packageName) continue;
    return message.executable;
  }
  throw new Error(
    `cargo build produced no executable artifact for ${kind} '${name}' in package '${packageName}'`,
  );
}

/** Discover Bevy targets and resolve build executables for owned tools. */
export class CargoRuntime {
  private readonly run: CargoRunner;

  constructor(run: CargoRunner = defaultRunner) {
    this.run = run;
  }

  /** List executable app/example targets under `root` (a directory or a
   * `Cargo.toml` path; default cwd). Deterministically ordered. */
  async listTargets(root?: string): Promise<BevyTarget[]> {
    const cwd = resolveManifestDir(root ?? process.cwd());
    const { stdout } = await this.run(
      'cargo',
      ['metadata', '--format-version', '1', '--no-deps'],
      { cwd },
    );
    return normalizeCargoMetadata(stdout);
  }

  /** Build a target via `cargo build -p <package> --bin/--example <name>`
   * (`--release` only when requested) and return the executable path reported
   * by the matching compiler artifact. Never predicts `target/` paths. */
  async build(
    target: BevyTarget,
    profile: 'debug' | 'release',
  ): Promise<{ executable: string }> {
    const args = [
      'build',
      '-p',
      target.packageName,
      target.kind === 'app' ? '--bin' : '--example',
      target.name,
      '--message-format=json-render-diagnostics',
    ];
    if (profile === 'release') args.push('--release');
    const { stdout } = await this.run('cargo', args, { cwd: target.packageRoot });
    return {
      executable: selectExecutableArtifact(
        stdout,
        target.packageName,
        target.name,
        target.kind,
      ),
    };
  }
}
