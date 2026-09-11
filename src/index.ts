#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createCleanup, exitAfterCleanup } from './cleanup.js';
import { createOwnedServer } from './server.js';

export async function main(): Promise<void> {
  const { server, services } = createOwnedServer();

  // Contractual cleanup order (AGENTS.md): watches -> processes -> server.
  // Idempotent via the shared in-flight run. A rejected cleanup means a
  // tracked child survived termination — the explicit process.exit paths
  // below are skipped in that case so the child is not orphaned, and the
  // attempt is retryable (the rejected run is not latched).
  const cleanup = createCleanup({
    stopWatches: () => services.watches.stopAll(),
    shutdownProcesses: () => services.processes.shutdownAll(),
    closeServer: () => server.close(),
  });

  // StdioServerTransport does not watch for stdin EOF itself; on EOF run the
  // cleanup chain and let the event loop drain so the process exits cleanly.
  // A surviving tracked child keeps the loop (and this process) alive.
  process.stdin.on('end', () => {
    void cleanup().catch(() => {});
  });

  // Signals bypass the stdin EOF path: run the SAME ordered cleanup, then
  // exit with the conventional 128+signal code — only when cleanup actually
  // succeeded (a failed child shutdown leaves the child tracked, so the
  // process stays up rather than orphaning it). The handler stays registered:
  // after a rejected cleanup a later signal retries shutdownAll instead of
  // falling through to Node's default termination, which would orphan the
  // still-tracked child.
  const exitOnSignal = (signal: NodeJS.Signals, code: number): void => {
    process.on(signal, () => {
      exitAfterCleanup(cleanup, code, (exitCode) => process.exit(exitCode));
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
