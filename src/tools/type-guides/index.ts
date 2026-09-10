/**
 * `brp_type_guide` and `brp_all_type_guides` — the two public type-guide tools.
 *
 * Ported from upstream `bevy_brp_mcp` 0.22.3 `tool_type_guide.rs` /
 * `tool_all_types.rs`, upstream commit
 * `85d0ecaed0b4aaebc5ba6d2b54026489e9e5042b`, MIT licensed
 * (see THIRD_PARTY_NOTICES.md).
 *
 * Both tools fetch the complete `registry.schema` map ONCE and build every
 * requested guide from that single loaded dataset (no N redundant requests).
 * Per-type processing failures never abort the batch; only registry-fetch
 * failures fail the whole call.
 */
import { DEFAULT_BRP_PORT } from '../../brp/client.js';
import { BrpError } from '../../brp/errors.js';
import type { BevyMcpServices } from '../../services.js';
import { brpErrorInfo, toolError, toolSuccess } from '../response.js';
import type { OwnedToolHandler } from '../register.js';
import type { Json } from './model.js';
import { buildTypeGuide } from './guidance.js';

const REGISTRY_SCHEMA_METHOD = 'registry.schema';
const LIST_COMPONENTS_METHOD = 'world.list_components';
const LIST_RESOURCES_METHOD = 'world.list_resources';

/** Wire shape of the upstream `TypeGuideResponse`. */
interface TypeGuideResponse {
  discovered_count: number;
  requested_types: string[];
  summary: {
    failed_discoveries: number;
    successful_discoveries: number;
    total_requested: number;
  };
  type_guide: Record<string, unknown>;
}

function isSuccessfulDiscovery(guide: unknown): boolean {
  return (
    typeof guide === 'object' &&
    guide !== null &&
    (guide as Record<string, unknown>)['in_registry'] === true &&
    !((guide as Record<string, unknown>)['error'] !== undefined &&
      (guide as Record<string, unknown>)['error'] !== null)
  );
}

/** Build the full response from one loaded registry (upstream `generate_response`). */
function generateTypeGuideResponse(
  registry: Map<string, Json>,
  requestedTypes: readonly string[],
): TypeGuideResponse {
  // Keyed by type name: duplicates dedupe, first occurrence wins.
  const typeGuide = new Map<string, unknown>();
  for (const name of requestedTypes) {
    if (typeGuide.has(name)) continue;
    typeGuide.set(name, buildTypeGuide(name, registry));
  }
  const guides = [...typeGuide.values()];
  const successfulDiscoveries = guides.filter(isSuccessfulDiscovery).length;
  return {
    discovered_count: successfulDiscoveries,
    requested_types: [...requestedTypes],
    summary: {
      failed_discoveries: guides.length - successfulDiscoveries,
      successful_discoveries: successfulDiscoveries,
      total_requested: requestedTypes.length,
    },
    type_guide: Object.fromEntries(typeGuide),
  };
}

/** Fetch the complete registry schema map in one BRP call (upstream `get_full_registry`). */
async function fetchRegistry(
  services: BevyMcpServices,
  port: number,
): Promise<Map<string, Json>> {
  let data: unknown;
  try {
    data = await services.brp.call(REGISTRY_SCHEMA_METHOD, {}, { port });
  } catch (error) {
    if (error instanceof BrpError) throw error;
    throw new BrpError(`Registry call failed: ${String(error)}`, { cause: error });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new BrpError('Registry call returned no data');
  }
  return new Map(Object.entries(data as Record<string, Json>));
}

/** Fetch one type-name list from a BRP list method (upstream `fetch_type_list`). */
async function fetchTypeList(
  services: BevyMcpServices,
  method: string,
  port: number,
): Promise<string[]> {
  let data: unknown;
  try {
    data = await services.brp.call(method, undefined, { port });
  } catch (error) {
    if (error instanceof BrpError) {
      throw new BrpError(`${method} failed: ${error.message}`, { cause: error });
    }
    throw new BrpError(`${method} failed: ${String(error)}`, { cause: error });
  }
  if (data === null || data === undefined) {
    throw new BrpError(`${method} returned no data`);
  }
  if (!Array.isArray(data)) {
    throw new BrpError(`${method} did not return an array of types`);
  }
  return data.filter((v): v is string => typeof v === 'string');
}

/** Common result envelope for both tools. */
function typeGuideResult(
  callInfo: { mcp_tool: string },
  message: string,
  parameters: Record<string, unknown>,
  response: TypeGuideResponse,
) {
  return toolSuccess(callInfo, message, {
    parameters,
    metadata: { type_count: response.discovered_count },
    result: response,
  });
}

function brpPort(args: Record<string, unknown>): number {
  return typeof args['port'] === 'number' ? (args['port'] as number) : DEFAULT_BRP_PORT;
}

/** Failure envelope mirroring the direct-tool error handling. */
function brpFailure(
  callInfo: { mcp_tool: string },
  parameters: Record<string, unknown>,
  error: unknown,
) {
  if (!(error instanceof BrpError)) throw error;
  return toolError(callInfo, error.message, {
    parameters,
    error_info: brpErrorInfo(error),
  });
}

/**
 * Generate the guide response for `types` against one fresh registry fetch.
 * Shared with the direct-tool format-error embedding (upstream
 * `generate_type_guide_response`).
 */
export async function generateTypeGuideResponseFor(
  services: BevyMcpServices,
  port: number,
  types: readonly string[],
): Promise<TypeGuideResponse> {
  const registry = await fetchRegistry(services, port);
  return generateTypeGuideResponse(registry, types);
}

/** `brp_type_guide`: resolve the requested types against one registry fetch. */
export function typeGuideHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const port = brpPort(args);
    const types = args['types'];
    const callInfo = { mcp_tool: 'brp_type_guide' } as const;
    const parameters = { types, port };
    if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) {
      return toolError(callInfo, "Invalid 'types': expected an array of type names", {
        parameters,
      });
    }
    try {
      const registry = await fetchRegistry(services, port);
      const response = generateTypeGuideResponse(registry, types as string[]);
      return typeGuideResult(
        callInfo,
        `Discovered ${response.discovered_count} type(s)`,
        parameters,
        response,
      );
    } catch (error) {
      return brpFailure(callInfo, parameters, error);
    }
  };
}

/** `brp_all_type_guides`: guides for every listed component and resource type. */
export function allTypeGuidesHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const port = brpPort(args);
    const callInfo = { mcp_tool: 'brp_all_type_guides' } as const;
    const parameters = { port };
    try {
      // Merge both type lists (upstream: components extended by resources).
      const componentTypes = await fetchTypeList(services, LIST_COMPONENTS_METHOD, port);
      const resourceTypes = await fetchTypeList(services, LIST_RESOURCES_METHOD, port);
      const allTypes = [...componentTypes, ...resourceTypes];

      const registry = await fetchRegistry(services, port);
      const response = generateTypeGuideResponse(registry, allTypes);
      return typeGuideResult(
        callInfo,
        `Discovered schemas for all ${response.discovered_count} registered type(s)`,
        parameters,
        response,
      );
    } catch (error) {
      return brpFailure(callInfo, parameters, error);
    }
  };
}
