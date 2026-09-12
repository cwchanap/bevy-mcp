import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
export function resolveManifestDir(root: string): string {
  const resolved = resolve(root);
  return basename(resolved) === 'Cargo.toml' ? dirname(resolved) : resolved;
}

/** Canonicalize like upstream `safe_canonicalize` (MIT): realpath when the
 * path exists so symlinked search roots and manifest dirs compare equal,
 * else the absolute-resolved path so the scope check still works. */
function canonicalizeOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Upstream `filter_targets_by_path_scope` (MIT): keep only targets whose
 * manifest directory is at-or-under the caller's search root. `cargo
 * metadata` expands a member dir to the whole workspace; the post-filter
 * restores the requested scope so a member path cannot expose (or launch)
 * sibling targets. Component-wise prefix check, not a string prefix. */
function withinScope(packageRoot: string, scope: string): boolean {
  const rel = relative(canonicalizeOrSelf(scope), canonicalizeOrSelf(packageRoot));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
  return normalizeMetadata(JSON.parse(stdout) as CargoMetadata);
}

function normalizeMetadata(metadata: CargoMetadata): BevyTarget[] {
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

/** Upstream `compute_relative_path` (MIT): `path` relative to the search
 * root; a path equal to the root reports its own directory name ('.' only
 * for the filesystem root), and a path outside the root stays absolute. */
export function computeRelativePath(path: string, searchRoot: string): string {
  const canonical = canonicalizeOrSelf(path);
  const rel = relative(canonicalizeOrSelf(searchRoot), canonical);
  if (rel === '') return basename(canonical) || '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel;
}

/** One Cargo project found by the shallow discovery scan: a standalone
 * project, or a workspace member carrying its canonical workspace root
 * (upstream `DiscoveredProject`, MIT). */
interface DiscoveredProject {
  dir: string;
  workspaceRoot?: string;
}

/** Discover Bevy targets and resolve build executables for owned tools. */
export class CargoRuntime {
  private readonly run: CargoRunner;

  constructor(run: CargoRunner = defaultRunner) {
    this.run = run;
  }

  /** Single `cargo metadata --format-version 1 --no-deps` call at `dir`. */
  private async metadataAt(dir: string): Promise<CargoMetadata> {
    const { stdout } = await this.run(
      'cargo',
      ['metadata', '--format-version', '1', '--no-deps'],
      { cwd: dir },
    );
    return JSON.parse(stdout) as CargoMetadata;
  }

  /** Upstream `process_cargo_toml` (MIT): classify one directory containing
   * a Cargo.toml as a workspace member (recording its canonical workspace
   * root) or a standalone project; a manifest Cargo cannot parse still
   * counts as a standalone candidate (upstream `add_fallback_standalone`).
   * Returns true only for a multi-member workspace root — its members are
   * already recorded through metadata so the caller skips the subdirectory
   * scan. Successful metadata is cached under the workspace root so the
   * collection pass does not run Cargo twice for one project. */
  private async processCargoToml(
    dir: string,
    discovered: Map<string, DiscoveredProject>,
    metadataByRoot: Map<string, CargoMetadata>,
  ): Promise<boolean> {
    const canonicalDir = canonicalizeOrSelf(dir);
    let metadata: CargoMetadata;
    try {
      metadata = await this.metadataAt(dir);
    } catch {
      discovered.set(canonicalDir, { dir: canonicalDir });
      return false;
    }
    const canonicalWorkspace = canonicalizeOrSelf(metadata.workspace_root ?? dir);
    metadataByRoot.set(canonicalWorkspace, metadata);
    if (canonicalDir !== canonicalWorkspace) {
      discovered.set(canonicalDir, { dir: canonicalDir, workspaceRoot: canonicalWorkspace });
      return false;
    }
    // Under --no-deps `packages` lists exactly the workspace members
    // (upstream `discover_workspace_members`).
    const memberDirs = (metadata.packages ?? [])
      .map((pkg) => dirname(pkg.manifest_path))
      .filter((memberDir) => existsSync(memberDir))
      .map((memberDir) => canonicalizeOrSelf(memberDir));
    if (memberDirs.length <= 1) {
      discovered.set(canonicalDir, { dir: canonicalDir });
      return false;
    }
    for (const memberDir of memberDirs) {
      discovered.set(memberDir, { dir: memberDir, workspaceRoot: canonicalWorkspace });
    }
    return true;
  }

  /** Upstream `iter_cargo_project_paths`/`shallow_scan` (MIT): the search
   * root plus its immediate non-hidden, non-`target` subdirectories that
   * contain a Cargo.toml are Cargo project candidates; workspace members
   * collapse to their workspace root, and a standalone dir that is also a
   * recorded member is dropped. `cargo metadata` never descends into child
   * directories, so without this scan a search root that merely *contains*
   * Bevy projects would list nothing. Returns the deduplicated project
   * dirs plus any metadata already fetched during classification. */
  private async discoverProjectDirs(root: string): Promise<{
    dirs: string[];
    metadataByRoot: Map<string, CargoMetadata>;
  }> {
    const discovered = new Map<string, DiscoveredProject>();
    const metadataByRoot = new Map<string, CargoMetadata>();
    const visited = new Set([canonicalizeOrSelf(root)]);

    const skipSubdirs = existsSync(join(root, 'Cargo.toml'))
      ? await this.processCargoToml(root, discovered, metadataByRoot)
      : false;

    if (!skipSubdirs) {
      let entries: Dirent[];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        // Upstream `should_skip_directory`, applied to children only — the
        // root itself is always scanned (RootDirectorySkipPolicy::Bypass).
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'target') {
          continue;
        }
        const subdir = join(root, entry.name);
        if (!existsSync(join(subdir, 'Cargo.toml'))) continue;
        if (!visited.add(canonicalizeOrSelf(subdir))) continue;
        await this.processCargoToml(subdir, discovered, metadataByRoot);
      }
    }

    const memberDirs = new Set(
      [...discovered.values()]
        .filter((project) => project.workspaceRoot !== undefined)
        .map((project) => project.dir),
    );
    const dirs = new Set<string>();
    for (const project of discovered.values()) {
      if (project.workspaceRoot !== undefined) dirs.add(project.workspaceRoot);
      else if (!memberDirs.has(project.dir)) dirs.add(project.dir);
    }
    return { dirs: [...dirs], metadataByRoot };
  }

  /** List executable app/example targets under `root` (a directory or a
   * `Cargo.toml` path; default cwd). Deterministically ordered. The search
   * covers the root and its immediate child Cargo projects (upstream
   * `iter_cargo_project_paths`, MIT), deduplicated by manifest + name +
   * kind; a project whose metadata fails is skipped rather than failing
   * the listing (upstream `if let Ok(detector)`). When `root` is given,
   * results are scoped to it — upstream applies the same post-filter only
   * for an explicit `path` (the implicit cwd search is unfiltered). */
  async listTargets(root?: string): Promise<BevyTarget[]> {
    const scope = resolveManifestDir(root ?? process.cwd());
    const { dirs, metadataByRoot } = await this.discoverProjectDirs(scope);
    const seen = new Set<string>();
    const targets: BevyTarget[] = [];
    for (const dir of dirs) {
      let metadata = metadataByRoot.get(dir);
      if (metadata === undefined) {
        try {
          metadata = await this.metadataAt(dir);
        } catch {
          continue;
        }
      }
      for (const target of normalizeMetadata(metadata)) {
        const key = `${target.manifestPath}::${target.name}::${target.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push(target);
        }
      }
    }
    targets.sort(
      (a, b) =>
        compareStrings(a.name, b.name) ||
        compareStrings(a.packageName, b.packageName) ||
        compareStrings(a.kind, b.kind),
    );
    if (root === undefined) return targets;
    return targets.filter((target) => withinScope(target.packageRoot, scope));
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
