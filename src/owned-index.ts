import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createOwnedServer } from './server.js';

export async function main(): Promise<void> {
  const { server, services } = createOwnedServer();

  // Contractual cleanup order (CLAUDE.md): watches -> processes -> server.
  // Idempotent: EOF and explicit closes must not run it twice.
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await services.watches.stopAll();
    await services.processes.shutdownAll();
    await server.close();
  };

  // StdioServerTransport does not watch for stdin EOF itself; on EOF run the
  // cleanup chain and let the event loop drain so the process exits cleanly.
  process.stdin.on('end', () => {
    void cleanup();
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
