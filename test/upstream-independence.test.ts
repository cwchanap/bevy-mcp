import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file's compiled location (`.test-build/test/`). */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Active runtime/build/config surfaces. Deliberately excluded: historical
// design docs (docs/), the redistributed contract fixture (contracts/),
// THIRD_PARTY_NOTICES.md (attribution), and the test suite itself (contains
// the scanned literals). Those are reference/attribution data, not
// executable dependencies.
const SCAN_TARGETS = [
  'src',
  'scripts',
  '.github',
  'plugins',
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

function collectFiles(target: string): string[] {
  const absolute = join(ROOT, target);
  if (statSync(absolute).isFile()) return [absolute];
  const files: string[] = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    const entry = join(target, dirent.name);
    if (dirent.isDirectory()) files.push(...collectFiles(entry));
    else if (dirent.isFile()) files.push(join(ROOT, entry));
  }
  return files;
}

test('active surfaces carry no executable dependency on upstream bevy_brp_mcp', () => {
  const violations: string[] = [];
  for (const target of SCAN_TARGETS) {
    for (const file of collectFiles(target)) {
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `upstream bevy_brp_mcp executable dependency leaked into active surfaces:\n${violations.join('\n')}`,
  );
});
