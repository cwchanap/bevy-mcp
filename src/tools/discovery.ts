import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError } from '../brp/errors.js';
import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/** The exact reflected type path of Bevy's `Name` component. */
const NAME_COMPONENT = 'bevy_ecs::name::Name';

const MATCH_MODES = new Set(['exact', 'prefix', 'suffix', 'contains']);

/** Live Bevy 0.19 wire shape of one `world.query` result row (observed). */
interface QueryRow {
  entity?: unknown;
  components?: Record<string, unknown>;
}

/**
 * Decode the live Name payload: Bevy 0.19 serializes `Name` as its inner
 * string under the reflected type path (verified against the running
 * fixture). Anything else cannot match.
 */
function decodeName(row: QueryRow): string | undefined {
  const value = row.components?.[NAME_COMPONENT];
  return typeof value === 'string' ? value : undefined;
}

function matches(name: string, pattern: string, mode: string): boolean {
  switch (mode) {
    case 'prefix':
      return name.startsWith(pattern);
    case 'suffix':
      return name.endsWith(pattern);
    case 'contains':
      return name.includes(pattern);
    default:
      return name === pattern;
  }
}

/**
 * MCP-local composite: one `world.query` for reflected `Name` components,
 * filtered by exact/prefix/suffix/contains (case-sensitive, literal `*`),
 * returning `{entity, name}` pairs sorted by entity ID. Asterisks are
 * ordinary characters, never wildcards.
 */
export function findEntitiesByNameHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const name = args.name as string;
    const matchMode = typeof args.match_mode === 'string' ? args.match_mode : 'exact';
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    const callInfo = { mcp_tool: 'world_find_entities_by_name' } as const;

    if (!MATCH_MODES.has(matchMode)) {
      return toolError(
        callInfo,
        `Invalid match_mode '${matchMode}': expected exact, prefix, suffix, or contains`,
      );
    }

    try {
      const rows = (await services.brp.call(
        'world.query',
        {
          data: { components: [NAME_COMPONENT] },
          filter: { with: [NAME_COMPONENT] },
        },
        { port },
      )) as QueryRow[];

      const result = rows
        .map((row) => ({ entity: row.entity, name: decodeName(row) }))
        .filter(
          (entry): entry is { entity: number; name: string } =>
            typeof entry.entity === 'number' && entry.name !== undefined,
        )
        .filter((entry) => matches(entry.name, name, matchMode))
        .sort((a, b) => a.entity - b.entity);

      return toolSuccess(callInfo, `Found ${result.length} named entities`, {
        metadata: { entity_count: result.length },
        result,
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      // Includes the BrpClient unsafe-integer rejection for 64-bit entity ids.
      return toolError(callInfo, `Internal error: ${error.message}`);
    }
  };
}
