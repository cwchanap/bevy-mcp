import { DEFAULT_BRP_PORT } from '../brp/client.js';
import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/**
 * The four watch tools over the native `+watch` SSE streams. Parameter names
 * are enforced by the captured input schemas; error/start messages mirror the
 * upstream 0.22.3 watch tools (MIT), with repository-owned log naming.
 */

const GET_WATCH = 'world_get_components_watch' as const;
const LIST_WATCH = 'world_list_components_watch' as const;

/** `world_get_components_watch`: entity + at least one component type. */
export function getComponentsWatchHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: GET_WATCH, brp_method: 'world.get_components+watch' } as const;
    const { entity, types } = args;
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    if (!Array.isArray(types)) {
      return toolError(
        callInfo,
        'components parameter is required for entity watch. Specify which components to monitor',
      );
    }
    if (types.length === 0) {
      return toolError(
        callInfo,
        'components array cannot be empty. Specify at least one component to watch',
      );
    }
    try {
      const watch = await services.watches.startGetComponents(entity as number, types as string[], port);
      return toolSuccess(callInfo, `Started watch ${watch.id}`, {
        metadata: { watch_id: watch.id, log_path: watch.path },
      });
    } catch (error) {
      return toolError(
        callInfo,
        `Failed to start entity watch for entity ${String(entity)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

/** `world_list_components_watch`: entity only. */
export function listComponentsWatchHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: LIST_WATCH, brp_method: 'world.list_components+watch' } as const;
    const { entity } = args;
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    try {
      const watch = await services.watches.startListComponents(entity as number, port);
      return toolSuccess(callInfo, `Started watch ${watch.id}`, {
        metadata: { watch_id: watch.id, log_path: watch.path },
      });
    } catch (error) {
      return toolError(
        callInfo,
        `Failed to start list watch for entity ${String(entity)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

/** `brp_list_active_watches`: local listing, no BRP traffic. */
export function listActiveWatchesHandler(services: BevyMcpServices): OwnedToolHandler {
  return async () => {
    const callInfo = { mcp_tool: 'brp_list_active_watches' } as const;
    const watches = services.watches.list();
    // Upstream `#[to_result]` places the bare array in `result`.
    return toolSuccess(callInfo, `Found ${watches.length} active watches`, {
      result: watches,
      metadata: { watch_count: watches.length },
    });
  };
}

/** `brp_stop_watch`: abort by ID; unknown ID is a tool error (upstream). */
export function stopWatchHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_stop_watch' } as const;
    const watchId = args.watch_id;
    if (typeof watchId !== 'number' || !Number.isInteger(watchId)) {
      return toolError(callInfo, 'watch_id must be a number');
    }
    if (!services.watches.stop(watchId)) {
      // Upstream double-wraps the manager failure through its error stack
      // (`Watch operation failed:`), so the message text repeats.
      return toolError(
        callInfo,
        `Failed to stop watch ${watchId}: Watch operation failed: Failed to stop watch ${watchId}: watch not found`,
      );
    }
    return toolSuccess(callInfo, `Stopped watch ${watchId}`, { metadata: { watch_id: watchId } });
  };
}
