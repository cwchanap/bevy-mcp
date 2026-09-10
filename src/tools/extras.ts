import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError } from '../brp/errors.js';
import type { BevyMcpServices } from '../services.js';
import { findEntitiesByName } from './discovery.js';
import { toolError, toolSuccess } from './response.js';
import { directBrpErrorExtras } from './brp-shape.js';
import type { OwnedToolHandler } from './register.js';

/**
 * Fixed MCP-tool -> BRP-method mapping for the 13 direct extras tools
 * (captured 0.22.3 default contract). Method is never taken from caller input.
 */
export const EXTRAS_DIRECT = {
  brp_extras_send_keys: 'brp_extras/send_keys',
  brp_extras_type_text: 'brp_extras/type_text',
  brp_extras_set_window_title: 'brp_extras/set_window_title',
  brp_extras_move_mouse: 'brp_extras/move_mouse',
  brp_extras_send_mouse_button: 'brp_extras/send_mouse_button',
  brp_extras_click_mouse: 'brp_extras/click_mouse',
  brp_extras_double_click_mouse: 'brp_extras/double_click_mouse',
  brp_extras_drag_mouse: 'brp_extras/drag_mouse',
  brp_extras_scroll_mouse: 'brp_extras/scroll_mouse',
  brp_extras_pinch_gesture: 'brp_extras/pinch_gesture',
  brp_extras_rotation_gesture: 'brp_extras/rotation_gesture',
  brp_extras_double_tap_gesture: 'brp_extras/double_tap_gesture',
  brp_extras_get_diagnostics: 'brp_extras/get_diagnostics',
} as const;

const SCREENSHOT_METHOD = 'brp_extras/screenshot';

/**
 * `brp_extras_screenshot` MCP-local composite: validates selector
 * combinations, resolves the exact-name mode through the shared local Name
 * lookup (never `brp_execute`), then forwards canonical
 * entity/camera/padding/path to `brp_extras/screenshot`.
 *
 * Modes per the captured contract: full window (no selector), camera-only
 * viewport, entity crop, exact-name crop. `entity` and `name` are mutually
 * exclusive; `padding` requires one of them; a name capture requires exactly
 * one exact match and sends only the resolved entity ID on the wire.
 */
export function screenshotHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    // Upstream registers this tool as a BRP tool for brp_extras/screenshot.
    const callInfo = { mcp_tool: 'brp_extras_screenshot', brp_method: SCREENSHOT_METHOD } as const;
    const { entity, name, camera, padding, path } = args;
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;

    if (entity !== undefined && name !== undefined) {
      return toolError(callInfo, 'Use either entity or name, never both');
    }
    if (padding !== undefined && entity === undefined && typeof name !== 'string') {
      return toolError(callInfo, 'padding requires an entity or name selector');
    }

    let params: Record<string, unknown> = {};
    if (typeof name === 'string') {
      let matches: { entity: number; name: string }[];
      try {
        matches = await findEntitiesByName(services, name, 'exact', port);
      } catch (error) {
        if (!(error instanceof BrpError)) throw error;
        // Includes the BrpClient unsafe-integer rejection for 64-bit entity ids.
        return toolError(callInfo, `Internal error: ${error.message}`);
      }
      if (matches.length === 0) {
        return toolError(callInfo, `No entity named '${name}' was found`);
      }
      if (matches.length > 1) {
        const ids = matches.map((match) => match.entity).join(', ');
        return toolError(
          callInfo,
          `Name '${name}' matched ${matches.length} entities (${ids}); ` +
            'use world_find_entities_by_name to inspect the duplicates and pick an entity ID',
        );
      }
      params.entity = matches[0]!.entity;
    } else if (entity !== undefined) {
      params.entity = entity;
    }
    if (camera !== undefined) params.camera = camera;
    if (padding !== undefined) params.padding = padding;
    params.path = path;

    try {
      const result = await services.brp.call(SCREENSHOT_METHOD, params, { port });
      // Upstream metadata: selector entity/name, each skipped when absent.
      const metadata = {
        ...(entity !== undefined ? { entity } : {}),
        ...(typeof name === 'string' ? { name } : {}),
      };
      return toolSuccess(callInfo, `Screenshot saved to ${String(path)}`, {
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(result !== undefined && result !== null ? { result } : {}),
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      const shaped = await directBrpErrorExtras(
        services,
        'brp_extras_screenshot',
        SCREENSHOT_METHOD,
        args,
        error,
      );
      return toolError(callInfo, shaped.message, {
        ...(shaped.metadata !== undefined ? { metadata: shaped.metadata } : {}),
      });
    }
  };
}
