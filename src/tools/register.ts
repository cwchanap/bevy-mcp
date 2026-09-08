import {
  fromJsonSchema,
  type CallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError } from '../brp/errors.js';
import { overrideDescription, type ToolContractCatalog } from '../tool-contracts.js';
import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess, brpErrorInfo, type CallInfo } from './response.js';
import { RESOURCE_DIRECT } from './resources.js';
import { WORLD_DIRECT } from './world.js';
import { findEntitiesByNameHandler } from './discovery.js';
import { executeHandler, listAgentToolsHandler } from './agent-tools.js';

/** Handler for an owned tool: receives the raw MCP call arguments. */
export type OwnedToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

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
    (args) => handler(args as Record<string, unknown>),
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
  registerOwnedTool(server, catalog, definition.name, async (args) => {
    const { port: portArg, ...params } = args;
    const port = typeof portArg === 'number' ? portArg : DEFAULT_BRP_PORT;
    const callInfo: CallInfo = { mcp_tool: definition.name, brp_method: definition.method };
    // Port is materialized like upstream's serde default, so responses always
    // carry the effective routing port; toolSuccess strips null optionals.
    const parameters = { ...args, port };
    try {
      const result = await services.brp.call(
        definition.method,
        Object.keys(params).length > 0 ? params : undefined,
        { port },
      );
      return toolSuccess(callInfo, `BRP call '${definition.method}' succeeded`, {
        parameters,
        result,
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      return toolError(callInfo, error.message, {
        parameters,
        error_info: brpErrorInfo(error),
      });
    }
  });
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
  registerOwnedTool(server, catalog, 'world_find_entities_by_name', findEntitiesByNameHandler(services));
  registerOwnedTool(server, catalog, 'brp_execute', executeHandler(services));
  registerOwnedTool(server, catalog, 'brp_list_agent_tools', listAgentToolsHandler(services));
}
