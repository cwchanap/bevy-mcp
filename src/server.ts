import { McpServer } from '@modelcontextprotocol/server';
import { createServices, type BevyMcpServices } from './services.js';

/** The owned MCP server plus the shared services its tools use. */
export interface OwnedServer {
  server: McpServer;
  services: BevyMcpServices;
}

/**
 * Assemble the repository-owned MCP server. Tools are registered through
 * `registerOwnedTool` (Task 2+); nothing is registered yet, and only tools
 * present in the captured contract may ever be registered here.
 */
export function createOwnedServer(): OwnedServer {
  const services = createServices();
  const server = new McpServer({
    name: '@cwchanap/bevy-plugin',
    version: '0.1.0',
  });
  return { server, services };
}
