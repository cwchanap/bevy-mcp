import { spawn } from 'node:child_process';

export const PREREQUISITE_COMMAND = 'cargo install bevy_brp_mcp --version 0.22.3 --locked';

/**
 * Spawn the upstream `bevy_brp_mcp` process with inherited stdio and resolve
 * to its exit code. No MCP parsing, no stdio buffering — a thin exec wrapper.
 *
 * @param {object} [options]
 * @param {string[]} [options.argv] CLI args passed through to the child.
 * @param {object} [options.env] Environment; BEVY_BRP_MCP_BIN overrides the command.
 * @param {typeof spawn} [options.spawnImpl] Injectable spawn for tests.
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<number> }}
 */
export function launchUpstream({ argv = [], env = process.env, spawnImpl = spawn } = {}) {
  const command = env.BEVY_BRP_MCP_BIN || 'bevy_brp_mcp';
  const child = spawnImpl(command, argv, { stdio: 'inherit', env });
  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          `bevy_brp_mcp not found on PATH.\nInstall it with:\n  ${PREREQUISITE_COMMAND}\n`
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
