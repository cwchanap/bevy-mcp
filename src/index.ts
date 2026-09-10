#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createOwnedServer } from './server.js';

export async function main(): Promise<void> {
  const { server, services } = createOwnedServer();

  // Contractual cleanup order (CLAUDE.md): watches -> processes -> server.
  // Idempotent: EOF, signals, and explicit closes must not run it twice.
  // Never rejects: failures go to stderr, never surface as unhandled
  // rejections (the signal paths exit explicitly right after).
  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await services.watches.stopAll();
      await services.processes.shutdownAll();
      await server.close();
    } catch (error) {
      console.error(error);
    }
  };

  // StdioServerTransport does not watch for stdin EOF itself; on EOF run the
  // cleanup chain and let the event loop drain so the process exits cleanly.
  process.stdin.on('end', () => {
    void cleanup();
  });

  // Signals bypass the stdin EOF path: run the SAME ordered cleanup, then
  // exit with the conventional 128+signal code.
  const exitOnSignal = (signal: NodeJS.Signals, code: number): void => {
    process.once(signal, () => {
      void cleanup().then(() => process.exit(code));
    });
  };
  exitOnSignal('SIGINT', 130);
  exitOnSignal('SIGTERM', 143);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
