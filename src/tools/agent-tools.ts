import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError, BrpJsonRpcError } from '../brp/errors.js';
import type { BevyMcpServices } from '../services.js';
import { brpErrorInfo, toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/** Method names from an OpenRPC-style `rpc.discover` document. */
function discoveredMethods(document: unknown): string[] {
  const methods = (document as { methods?: unknown })?.methods;
  if (!Array.isArray(methods)) return [];
  return methods
    .map((entry) => (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * `brp_execute`: validate the requested method against a live `rpc.discover`,
 * then invoke it through `BrpClient`. This handler is registered standalone;
 * no other handler may import or call it (it is never a fallback).
 */
export function executeHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const method = args.method as string;
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    const callInfo = { mcp_tool: 'brp_execute' } as const;

    let available: string[];
    try {
      available = discoveredMethods(await services.brp.discover(port));
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      return toolError(callInfo, `Failed to discover BRP methods on port ${port}`, {
        metadata: { stage: 'discovery', port, error: error.message },
      });
    }

    if (!available.includes(method)) {
      return toolError(callInfo, `BRP method \`${method}\` is not registered on port ${port}`, {
        metadata: {
          stage: 'discovery',
          method,
          port,
          available_methods: [...available].sort(),
        },
      });
    }

    try {
      const params = 'params' in args ? args.params : undefined;
      const result = await services.brp.call(method, params, { port });
      return toolSuccess(callInfo, `Executed method ${method}`, { result });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      return toolError(callInfo, error.message, { error_info: brpErrorInfo(error) });
    }
  };
}

/** Upstream injects these instructions into the public result under `usage`. */
const AGENT_TOOLS_USAGE = "Pass an entry's method and matching params to brp_execute.";

/**
 * `brp_list_agent_tools`: fetch the application-published curated catalog via
 * `brp_extras/agent_tools`, inject the public `result.usage` instructions, and
 * preserve the rest of the result verbatim.
 */
export function listAgentToolsHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    const callInfo = { mcp_tool: 'brp_list_agent_tools' } as const;

    try {
      const fetched = await services.brp.call('brp_extras/agent_tools', undefined, { port });
      const result: Record<string, unknown> = {
        usage: AGENT_TOOLS_USAGE,
        ...(typeof fetched === 'object' && fetched !== null ? fetched : {}),
      };
      const count = Array.isArray(result.tools) ? result.tools.length : 0;
      return toolSuccess(callInfo, `Listed ${count} agent tools`, {
        metadata: { tool_count: count },
        result,
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      const metadata: Record<string, unknown> = {
        stage: 'catalog_fetch',
        method: 'brp_extras/agent_tools',
        port,
        error: error.message,
      };
      if (error instanceof BrpJsonRpcError) metadata.code = error.code;
      return toolError(callInfo, `Unable to fetch the agent tool catalog from port ${port}`, {
        metadata,
      });
    }
  };
}
