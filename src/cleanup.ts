/**
 * Server shutdown orchestration. The cleanup order is contractual
 * (AGENTS.md): watches -> processes -> server.
 */

/** The three ordered shutdown steps, each an awaitable unit. */
export interface ShutdownSteps {
  stopWatches(): Promise<void>;
  shutdownProcesses(): Promise<void>;
  closeServer(): Promise<void>;
}

/**
 * One shared in-flight cleanup: EOF, signals, and explicit closes all await
 * the same promise, so a signal arriving during an EOF-triggered cleanup
 * still waits for it to finish.
 *
 * Every step is attempted even when an earlier one fails — a failed
 * `shutdownProcesses` must not skip `closeServer`. The first failure is
 * rethrown after all steps ran: a child that survived the SIGTERM/SIGKILL
 * sequence stays tracked in the ProcessManager, and the rejected cleanup
 * tells callers the process is NOT clean to exit. Failures are logged to
 * stderr here so rejection handlers never re-log or re-surface them.
 */
export function createCleanup(steps: ShutdownSteps): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      let failed = false;
      let firstFailure: unknown;
      for (const step of [
        steps.stopWatches,
        steps.shutdownProcesses,
        steps.closeServer,
      ]) {
        try {
          await step();
        } catch (error) {
          console.error(error);
          if (!failed) {
            failed = true;
            firstFailure = error;
          }
        }
      }
      if (failed) throw firstFailure;
    })();
    return cleanupPromise;
  };
}

/**
 * Await the shared cleanup, then exit with `code`. When cleanup rejects —
 * e.g. a tracked child survived termination — the explicit exit is skipped:
 * the still-tracked child keeps the process alive for a later retry or its
 * own exit instead of being orphaned.
 */
export function exitAfterCleanup(
  cleanup: () => Promise<void>,
  code: number,
  exit: (code: number) => void,
): void {
  void cleanup().then(
    () => exit(code),
    () => {},
  );
}
