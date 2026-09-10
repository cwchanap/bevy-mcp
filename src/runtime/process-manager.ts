import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/**
 * Referenced Bevy child-process tracking. Spawned children are never
 * `unref()`ed, are kept until exit, and share the LogStore-provided app log
 * file for stdout and stderr. `shutdownAll` is the contractual cleanup step
 * between `watches.stopAll()` and `server.close()`.
 */

/** Environment variable carrying the BRP extras port assigned to a child. */
export const BRP_EXTRAS_PORT_ENV = 'BRP_EXTRAS_PORT';

/** One launch request. `logPath` comes from the LogStore, never the caller. */
export interface LaunchSpec {
  appName: string;
  executable: string;
  args?: readonly string[];
  env?: Record<string, string>;
  port: number;
  logPath: string;
  cwd?: string;
}

/** Public view of one tracked child. */
export interface TrackedProcess {
  readonly appName: string;
  readonly pid: number;
  readonly port: number;
  readonly logPath: string;
  /** Resolves once the child exits (normally or after termination). */
  readonly exited: Promise<void>;
  /** False once the exit event has fired. */
  isAlive(): boolean;
}

/** Spawn seam so tests fake children (async process execution stays injectable). */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Bounded SIGTERM -> SIGKILL interval. */
const DEFAULT_KILL_GRACE_MS = 5_000;

interface TrackedChild extends TrackedProcess {
  child: ChildProcess;
}

/** Process/app lifecycle operations the owned tools use. */
export interface ProcessService {
  launch(spec: LaunchSpec): TrackedProcess;
  /** Tracked children for `appName` (entries drop out once they exit). */
  findByApp(appName: string): TrackedProcess[];
  /** Resolves true when the child exited within `timeoutMs`. */
  waitForExit(process: TrackedProcess, timeoutMs: number): Promise<boolean>;
  /** SIGTERM, wait the bounded grace, then SIGKILL; no-op on exited children. */
  terminate(process: TrackedProcess): Promise<void>;
  /** Terminate every tracked child; safe to call repeatedly. */
  shutdownAll(): Promise<void>;
}

export class ProcessManager implements ProcessService {
  readonly #spawn: SpawnImpl;
  readonly #killGraceMs: number;
  #children: TrackedChild[] = [];

  constructor(spawn: SpawnImpl = nodeSpawn, killGraceMs: number = DEFAULT_KILL_GRACE_MS) {
    this.#spawn = spawn;
    this.#killGraceMs = killGraceMs;
  }

  launch(spec: LaunchSpec): TrackedProcess {
    // Env merge order is contractual: process.env < user env < assigned port.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...spec.env,
      [BRP_EXTRAS_PORT_ENV]: String(spec.port),
    };
    // stdout and stderr share one append handle (upstream clones the log file
    // for stderr); the parent closes its copy once the child owns its dup.
    const fd = openSync(spec.logPath, 'a');
    let child: ChildProcess;
    try {
      child = this.#spawn(spec.executable, [...(spec.args ?? [])], {
        env,
        cwd: spec.cwd,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    if (child.pid === undefined) {
      // Spawn failed (e.g. ENOENT); consume the async 'error' event so it
      // cannot crash the process, then surface the failure synchronously.
      child.once('error', () => {});
      throw new Error(`Failed to spawn '${spec.executable}'`);
    }

    const tracked: TrackedChild = {
      appName: spec.appName,
      pid: child.pid,
      port: spec.port,
      logPath: spec.logPath,
      exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      isAlive: () => child.exitCode === null && child.signalCode === null,
      child,
    };
    const drop = (): void => {
      this.#children = this.#children.filter((entry) => entry !== tracked);
    };
    child.once('exit', drop);
    child.once('error', drop);
    this.#children.push(tracked);
    return tracked;
  }

  findByApp(appName: string): TrackedProcess[] {
    return this.#children.filter((entry) => entry.appName === appName);
  }

  /**
   * Resolves true when the child exited within `timeoutMs`. The losing
   * timeout is cleared on settle so it never keeps the event loop (and an
   * exiting process) alive for the remaining grace period.
   */
  async waitForExit(process: TrackedProcess, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([process.exited.then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async terminate(process: TrackedProcess): Promise<void> {
    const tracked = process as TrackedChild;
    if (!tracked.isAlive()) return;
    tracked.child.kill('SIGTERM');
    if (await this.waitForExit(tracked, this.#killGraceMs)) return;
    tracked.child.kill('SIGKILL');
    await this.waitForExit(tracked, this.#killGraceMs);
  }

  async shutdownAll(): Promise<void> {
    const survivors = this.#children;
    this.#children = [];
    await Promise.all(survivors.map((entry) => this.terminate(entry)));
  }
}
