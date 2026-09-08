import {
  fromJsonSchema,
  type CallToolResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { overrideDescription, type ToolContractCatalog } from '../tool-contracts.js';

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
