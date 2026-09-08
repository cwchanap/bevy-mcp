import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JsonSchemaType, ToolAnnotations } from '@modelcontextprotocol/server';

/** One tool entry as captured from upstream 0.22.3 `tools/list` (Task 0 fixture). */
export interface CapturedToolContract {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: JsonSchemaType;
  outputSchema: JsonSchemaType;
}

const CONTRACT_FILE = 'bevy-brp-mcp-0.22.3-tools.json';

// Resolve the fixture relative to this compiled module: build/tool-contracts.js
// and .test-build/src/tool-contracts.js sit one and two levels under the repo
// root respectively, so try both depths. Never load from anywhere else.
function contractFixtureUrl(): URL {
  for (const up of ['..', '../..']) {
    const url = new URL(`${up}/contracts/${CONTRACT_FILE}`, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw new Error(
    `contract fixture ${CONTRACT_FILE} not found relative to ${fileURLToPath(import.meta.url)}`,
  );
}

/**
 * Description-only prose substitutions for retired upstream log-filename
 * wording (`bevy_brp_mcp_*` -> repository-owned `bevy-mcp` naming).
 *
 * Rule: prose-only. Tool names, schemas, and annotations must never be
 * overridden (CLAUDE.md "Tool contract rules"). Each entry must be a narrowly
 * reviewed substitution; entries covering more than the retired upstream log
 * filenames are rejected at review.
 */
export const CONTRACT_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['bevy_brp_mcp', 'bevy-mcp'],
]);

/** Apply the reviewed description overrides to a captured description. */
export function overrideDescription(description: string): string {
  let result = description;
  for (const [from, to] of CONTRACT_OVERRIDES) {
    result = result.replaceAll(from, to);
  }
  return result;
}

/** Read-only view over the captured 0.22.3 tool contract fixture. */
export class ToolContractCatalog {
  readonly #tools: ReadonlyMap<string, CapturedToolContract>;

  constructor(tools: readonly CapturedToolContract[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** The captured contract for `name`; throws on unknown tool names. */
  get(name: string): CapturedToolContract {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new Error(`no captured contract for tool: ${name}`);
    }
    return tool;
  }

  /** All captured tool names (sorted, matching the fixture order). */
  names(): string[] {
    return [...this.#tools.keys()];
  }
}

const REQUIRED_CAPTURED_FIELDS = [
  'name',
  'title',
  'description',
  'annotations',
  'inputSchema',
  'outputSchema',
] as const;

/** Load and shape-check the checked-in contract fixture. */
export function loadToolContractCatalog(): ToolContractCatalog {
  const parsed = JSON.parse(readFileSync(contractFixtureUrl(), 'utf8')) as {
    tools?: unknown;
  };
  if (!Array.isArray(parsed.tools)) {
    throw new Error(`contract fixture is missing a "tools" array: ${CONTRACT_FILE}`);
  }
  const tools = parsed.tools.map((entry, index) => {
    const tool = entry as CapturedToolContract;
    for (const field of REQUIRED_CAPTURED_FIELDS) {
      if (tool[field] === undefined) {
        throw new Error(`contract fixture tools[${index}] is missing "${field}"`);
      }
    }
    return tool;
  });
  return new ToolContractCatalog(tools);
}
