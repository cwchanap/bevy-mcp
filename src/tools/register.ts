import {
  fromJsonSchema,
  type CallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError } from '../brp/errors.js';
import { overrideDescription, type ToolContractCatalog } from '../tool-contracts.js';
import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess, type CallInfo } from './response.js';
import { directBrpErrorExtras, directEchoParameters, directShape, echoParameters } from './brp-shape.js';
import { RESOURCE_DIRECT } from './resources.js';
import { WORLD_DIRECT } from './world.js';
import { findEntitiesByNameHandler } from './discovery.js';
import { executeHandler, listAgentToolsHandler } from './agent-tools.js';
import {
  deleteLogsHandler,
  listLogsHandler,
  readLogHandler,
} from './logs.js';
import {
  launchHandler,
  listBevyHandler,
  shutdownHandler,
  statusHandler,
} from './app.js';
import { EXTRAS_DIRECT, screenshotHandler } from './extras.js';
import { allTypeGuidesHandler, typeGuideHandler } from './type-guides/index.js';
import {
  getComponentsWatchHandler,
  listActiveWatchesHandler,
  listComponentsWatchHandler,
  stopWatchHandler,
} from './watches.js';

/** Handler for an owned tool: receives the raw MCP call arguments. */
export type OwnedToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * How the handler's `parameters` echo is derived (upstream semantics):
 * - `default`: serde echo with materialized defaults plus
 *   `optional_parameters_not_provided`; success envelopes always echo, error
 *   envelopes only when the handler attached `parameters`.
 * - `direct`: the macro-generated BRP-tool family — silently drops absent
 *   optionals, never emits the omitted list (see directEchoParameters).
 * - `none`: bespoke `handle_impl` tools whose ToolResult keeps `params: None`
 *   — no echo at all.
 */
type EchoMode = 'default' | 'direct' | 'none';

function applyParameterEcho(
  result: CallToolResult,
  contract: ReturnType<ToolContractCatalog['get']>,
  args: Record<string, unknown>,
  mode: EchoMode,
): CallToolResult {
  if (mode === 'none') return result;
  const response = result.structuredContent as Record<string, unknown> | undefined;
  if (!response || !('status' in response)) return result;
  if (response['status'] !== 'success') {
    if (mode === 'direct' || response['parameters'] === undefined) return result;
  }
  response['parameters'] =
    mode === 'direct' ? directEchoParameters(contract, args) : echoParameters(contract, args);
  // Rebuild the text content from the final structuredContent so both stay
  // one JSON serialization of the same envelope.
  return {
    ...result,
    structuredContent: response,
    content: [{ type: 'text', text: JSON.stringify(response) }],
  };
}

/**
 * Register one owned tool using the captured 0.22.3 contract: captured
 * title/description/annotations and the raw captured input/output schemas are
 * passed through the SDK's official JSON-Schema adapter. `name` must exist in
 * the catalog; unknown tool names throw immediately.
 */
export function registerOwnedTool(
  server: McpServer,
  catalog: ToolContractCatalog,
  name: string,
  handler: OwnedToolHandler,
  echoMode: EchoMode = 'default',
): void {
  const contract = catalog.get(name);
  server.registerTool(
    name,
    {
      title: contract.title,
      description: overrideDescription(contract.description),
      annotations: contract.annotations,
      inputSchema: fromJsonSchema(contract.inputSchema),
      outputSchema: fromJsonSchema(contract.outputSchema),
    },
    async (args) =>
      applyParameterEcho(
        await handler(args as Record<string, unknown>),
        contract,
        args as Record<string, unknown>,
        echoMode,
      ),
  );
}

/**
 * Register one direct BRP passthrough tool: the MCP tool always calls the one
 * fixed BRP method named in `definition` (never a caller-supplied method).
 * `port` is extracted for routing (defaulting to DEFAULT_BRP_PORT); the
 * remaining fields are forwarded as the BRP `params` object.
 */
export function registerDirectBrpTool(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
  definition: { name: string; method: string },
): void {
  registerOwnedTool(
    server,
    catalog,
    definition.name,
    async (args) => {
      const { port: portArg, ...params } = args;
      const port = typeof portArg === 'number' ? portArg : DEFAULT_BRP_PORT;
      const callInfo: CallInfo = { mcp_tool: definition.name, brp_method: definition.method };
      try {
        const result = await services.brp.call(
          definition.method,
          Object.keys(params).length > 0 ? params : undefined,
          { port },
        );
        // Raw BRP result passthrough (upstream skip_if_none); upstream derives
        // the message template and count metadata per tool.
        const shape = directShape(definition.name)(result, args);
        return toolSuccess(callInfo, shape.message, {
          ...(shape.metadata !== undefined ? { metadata: shape.metadata } : {}),
          ...(result !== undefined && result !== null ? { result } : {}),
        });
      } catch (error) {
        if (!(error instanceof BrpError)) throw error;
        const shaped = await directBrpErrorExtras(
          services,
          definition.name,
          definition.method,
          args,
          error,
        );
        return toolError(callInfo, shaped.message, {
          ...(shaped.metadata !== undefined ? { metadata: shaped.metadata } : {}),
        });
      }
    },
    'direct',
  );
}

/**
 * Register the 13 direct extras passthrough tools plus the
 * `brp_extras_screenshot` composite.
 */
export function registerExtrasTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  for (const [name, method] of Object.entries(EXTRAS_DIRECT)) {
    registerDirectBrpTool(server, services, catalog, { name, method });
  }
  registerOwnedTool(server, catalog, 'brp_extras_screenshot', screenshotHandler(services));
}

/** Register every direct world/resource BRP tool from the fixed mappings. */
export function registerDirectTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  for (const [name, method] of Object.entries({ ...WORLD_DIRECT, ...RESOURCE_DIRECT })) {
    registerDirectBrpTool(server, services, catalog, { name, method });
  }
}

/**
 * Register the three composite/discovery tools: the MCP-local name lookup,
 * the discovery-gated `brp_execute`, and the agent-tool catalog listing.
 * Each is registered exactly once here; no other handler may call them.
 */
export function registerDiscoveryTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  registerOwnedTool(server, catalog, 'world_find_entities_by_name', findEntitiesByNameHandler(services), 'none');
  registerOwnedTool(server, catalog, 'brp_execute', executeHandler(services), 'none');
  registerOwnedTool(server, catalog, 'brp_list_agent_tools', listAgentToolsHandler(services), 'none');
}

/**
 * Register the two public type-guide tools. Both resolve against one live
 * `registry.schema` fetch per call; guides are built from that single dataset.
 */
export function registerTypeGuideTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  registerOwnedTool(server, catalog, 'brp_type_guide', typeGuideHandler(services));
  registerOwnedTool(server, catalog, 'brp_all_type_guides', allTypeGuidesHandler(services));
}

/**
 * Register the four watch tools: two native `+watch` SSE stream starters and
 * the local active-watch listing/stop tools.
 */
export function registerWatchTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  registerOwnedTool(server, catalog, 'world_get_components_watch', getComponentsWatchHandler(services));
  registerOwnedTool(server, catalog, 'world_list_components_watch', listComponentsWatchHandler(services));
  registerOwnedTool(server, catalog, 'brp_list_active_watches', listActiveWatchesHandler(services));
  registerOwnedTool(server, catalog, 'brp_stop_watch', stopWatchHandler(services));
}

/**
 * Register the four process/app lifecycle tools: target discovery, launch,
 * live status, and graceful-then-terminating shutdown.
 */
export function registerAppTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  registerOwnedTool(server, catalog, 'brp_list_bevy', listBevyHandler(services));
  registerOwnedTool(server, catalog, 'brp_launch', launchHandler(services));
  registerOwnedTool(server, catalog, 'brp_status', statusHandler(services));
  registerOwnedTool(server, catalog, 'brp_shutdown', shutdownHandler(services));
}

/**
 * Register the three log tools with their exact public contracts. Callers
 * only pass bare filenames, app names, and ages — never absolute paths or
 * BRP ports.
 */
export function registerLogTools(
  server: McpServer,
  services: BevyMcpServices,
  catalog: ToolContractCatalog,
): void {
  registerOwnedTool(server, catalog, 'brp_list_logs', listLogsHandler(services));
  registerOwnedTool(server, catalog, 'brp_read_log', readLogHandler(services));
  registerOwnedTool(server, catalog, 'brp_delete_logs', deleteLogsHandler(services));
}
