import { McpServer } from '@modelcontextprotocol/server';
import { createServices, type BevyMcpServices } from './services.js';
import { registerDirectTools, registerDiscoveryTools, registerTypeGuideTools } from './tools/register.js';

/** The owned MCP server plus the shared services its tools use. */
export interface OwnedServer {
  server: McpServer;
  services: BevyMcpServices;
}

/**
 * Assemble the repository-owned MCP server: shared services plus every tool
 * implemented so far (direct fixed-method tools and discovery composites),
 * all registered through `registerOwnedTool` from the captured contract.
 * Only tools present in the captured contract may ever be registered here.
 */
export function createOwnedServer(): OwnedServer {
  const services = createServices();
  const server = new McpServer({
    name: '@cwchanap/bevy-plugin',
    version: '0.1.0',
  });
  registerDirectTools(server, services, services.catalog);
  registerDiscoveryTools(server, services, services.catalog);
  registerTypeGuideTools(server, services, services.catalog);
  return { server, services };
}
