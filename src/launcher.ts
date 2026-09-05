import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export const PREREQUISITE_COMMAND = 'cargo install bevy_brp_mcp --version 0.22.3 --locked';

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LaunchOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnImpl;
}

/**
 * Spawn the upstream `bevy_brp_mcp` process with inherited stdio and resolve
 * to its exit code. No MCP parsing, no stdio buffering — a thin exec wrapper.
 */
export function launchUpstream({
  argv = [],
  env = process.env,
  spawnImpl = spawn,
}: LaunchOptions = {}) {
  const command = env.BEVY_BRP_MCP_BIN || 'bevy_brp_mcp';
  const child = spawnImpl(command, argv, { stdio: 'inherit', env });
  const done = new Promise<number>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          `bevy_brp_mcp not found on PATH.\nInstall it with:\n  ${PREREQUISITE_COMMAND}\n`,
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  return { child, done };
}
