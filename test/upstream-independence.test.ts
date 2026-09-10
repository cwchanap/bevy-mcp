import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file's compiled location (`.test-build/test/`). */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Active runtime/build/config surfaces — including every client entrypoint
// named by CLAUDE.md (root manifests, Codex/Claude plugin manifests, and the
// `.claude-plugin/` + `.agents/` marketplace manifests). Deliberately
// excluded: historical design docs (docs/), the redistributed contract
// fixture (contracts/), THIRD_PARTY_NOTICES.md (attribution), and the test
// suite itself (contains the scanned literals). Those are reference/attribution
// data, not executable dependencies.
const SCAN_TARGETS = [
  'src',
  'scripts',
  '.github',
  'plugins',
  '.claude-plugin',
  '.agents',
  'package.json',
  'plugin.json',
  'mcp.json',
  'README.md',
  'CLAUDE.md',
];

// The upstream executable-dependency patterns. Attribution prose that merely
// names the upstream project does not match any of these.
const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'cargo install bevy_brp_mcp', pattern: /cargo\s+install\s+bevy_brp_mcp/ },
  { name: 'BEVY_BRP_MCP_BIN override', pattern: /BEVY_BRP_MCP_BIN/ },
  {
    name: 'spawn/exec of bevy_brp_mcp',
    pattern: /(?:spawn|exec(?:File)?|Command::new)\s*\(\s*['"`]bevy_brp_mcp/,
  },
  { name: 'npx bevy_brp_mcp', pattern: /\bnpx\s+bevy_brp_mcp\b/ },
  { name: '"command": "bevy_brp_mcp" manifest entry', pattern: /"command"\s*:\s*"bevy_brp_mcp/ },
];

/** Scan `base`-relative targets; returns `file: violation` pairs. */
function scanFrom(base: string, targets: ReadonlyArray<string>): string[] {
  const violations: string[] = [];
  for (const target of targets) {
    for (const file of collectFiles(base, target)) {
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${name}`);
      }
    }
  }
  return violations;
}

function collectFiles(base: string, target: string): string[] {
  const absolute = join(base, target);
  if (statSync(absolute).isFile()) return [absolute];
  const files: string[] = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    const entry = join(target, dirent.name);
    if (dirent.isDirectory()) files.push(...collectFiles(base, entry));
    else if (dirent.isFile()) files.push(join(base, entry));
  }
  return files;
}

test('active surfaces carry no executable dependency on upstream bevy_brp_mcp', () => {
  assert.deepEqual(
    scanFrom(ROOT, SCAN_TARGETS),
    [],
    'upstream bevy_brp_mcp executable dependency leaked into active surfaces',
  );
});

test('scanner negative probe: planted violations in scanned targets are detected', () => {
  // Self-check that the scan is not vacuous — including over the dot-prefixed
  // marketplace targets — by planting one forbidden literal per pattern.
  const probe = mkdtempSync(join(tmpdir(), 'bevy-mcp-scan-probe-'));
  try {
    const planted = [
      writeViolation(probe, 'install.txt', 'run: cargo install bevy_brp_mcp'),
      writeViolation(probe, 'env.txt', 'BEVY_BRP_MCP_BIN=/tmp/upstream'),
      writeViolation(probe, 'spawn.txt', "spawn('bevy_brp_mcp')"),
      writeViolation(probe, 'npx.txt', 'npx bevy_brp_mcp serve'),
      writeViolation(probe, 'manifest.json', '{"command": "bevy_brp_mcp"}'),
    ];
    const violations = scanFrom(probe, planted);
    assert.equal(violations.length, FORBIDDEN.length, 'every planted pattern must be detected');
    assert.ok(violations.every((line) => line.startsWith(probe)));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }

  // Dot-prefixed directories must actually be traversed (readdir includes
  // dotfiles, but prove it on the real targets).
  const dotTargets = SCAN_TARGETS.filter((target) => target.startsWith('.'));
  assert.ok(dotTargets.length >= 2, 'the marketplace targets are scanned');
  for (const target of dotTargets) {
    const files = collectFiles(ROOT, target);
    assert.ok(files.length > 0, `${target} must contain scanned files`);
    assert.ok(
      files.every((file) => file.includes(target)),
      `${target} files resolve under the repo root`,
    );
  }
});

function writeViolation(dir: string, name: string, literal: string): string {
  const path = join(dir, name);
  writeFileSync(path, literal);
  return name;
}
