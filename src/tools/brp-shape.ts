/**
 * Upstream-compatible response shaping for direct BRP tools, translated from
 * `bevy_brp_mcp` 0.22.3 (MIT, see THIRD_PARTY_NOTICES.md):
 *
 * - per-tool success `message` templates and `metadata` derivations
 *   (`ResultStruct` `to_message`/`to_metadata` operations in
 *   `brp_tools/tools/*.rs` and the macros' `result_struct.rs`);
 * - BRP error enhancement ("(error code)" suffix, entity-context rewrite,
 *   method-not-found extras suffix) from `brp_client/client.rs`;
 * - format-error embedding of type guides for the five `enhanced_errors`
 *   tools (extract-type rules from `brp_client/operation.rs`);
 * - the serde parameter echo (materialized `#[serde(default)]` fields plus
 *   `optional_parameters_not_provided`) built from the captured schemas.
 */
import type { CapturedToolContract } from '../tool-contracts.js';
import { BrpJsonRpcError } from '../brp/errors.js';
import type { BevyMcpServices } from '../services.js';

/** JSON value accessor helpers shared by the count operations. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Macro `count`: array or object length, else 0. */
function countOf(value: unknown): number {
  return asArray(value)?.length ?? Object.keys(asObject(value) ?? {}).length;
}

/** Macro `count_components`: `components` object size, else non-error keys. */
function countComponents(value: unknown): number {
  const obj = asObject(value);
  if (!obj) return 0;
  const components = asObject(obj['components']);
  if (components) return Object.keys(components).length;
  return Object.keys(obj).filter((key) => key !== 'errors').length;
}

/** Macro `count_errors`: length of `errors` when it is an array. */
function countErrors(value: unknown): number | undefined {
  const obj = asObject(value);
  if (!obj || obj['errors'] === undefined) return undefined;
  return asArray(obj['errors'])?.length;
}

/** Macro `count_query_components`: total object size across result rows. */
function countQueryComponents(value: unknown): number {
  const rows = asArray(value) ?? [];
  let total = 0;
  for (const row of rows) total += Object.keys(asObject(row) ?? {}).length;
  return total;
}

/** Macro `count_methods`: length of `result.methods`. */
function countMethods(value: unknown): number {
  return asArray(asObject(value)?.['methods'])?.length ?? 0;
}

/** Macro `extract_entity`: `result.entity` as number, else 0. */
function extractEntity(value: unknown): number {
  const entity = asObject(value)?.['entity'];
  return typeof entity === 'number' ? entity : 0;
}

/** Macro `extract_duration_ms`: `result.duration_ms`, else the default 100. */
const DEFAULT_DURATION_MS = 100;
function extractDurationMs(value: unknown): number {
  const duration = asObject(value)?.['duration_ms'];
  return typeof duration === 'number' ? duration : DEFAULT_DURATION_MS;
}

/** Macro `extract_*` for string/vec fields with defaults. */
function extractString(value: unknown, key: string): string {
  const field = asObject(value)?.[key];
  return typeof field === 'string' ? field : '';
}

function extractArray(value: unknown, key: string): unknown[] {
  return asArray(asObject(value)?.[key]) ?? [];
}

/**
 * Success shaping per direct tool: derives the upstream `message` and
 * `metadata` from the raw BRP result plus the call arguments. `result` is
 * always the raw BRP value (omitted when null by the caller, matching
 * `skip_serializing_if = "Option::is_none"`).
 */
export type DirectShape = (
  result: unknown,
  args: Record<string, unknown>,
) => { message: string; metadata?: Record<string, unknown> };

function param(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : String(value);
}

/** The five tools compiled with `#[brp_result(enhanced_errors = true)]`. */
export const ENHANCED_ERROR_TOOLS: ReadonlySet<string> = new Set([
  'world_spawn_entity',
  'world_insert_components',
  'world_mutate_components',
  'world_insert_resources',
  'world_mutate_resources',
]);

/** Codes upstream treats as format errors (`has_format_error_code`). */
const FORMAT_ERROR_CODES: ReadonlySet<number> = new Set([-32602, -32603, -23402, -23501]);

/** JSON-RPC method-not-found code. */
const METHOD_NOT_FOUND = -32601;

/** Upstream `ERROR_PATTERNS` fallback type extraction (client.rs). */
const ERROR_PATTERNS = [/Unknown component type: `([^`]+)`/, /([a-zA-Z0-9_:]+) is invalid:/];

/**
 * Type extraction from the call parameters (upstream `Operation::
 * extract_type_names`): components-object keys for spawn/insert, the
 * `component`/`resource` string for mutations.
 */
function extractTypesFromParams(args: Record<string, unknown>): string[] {
  const components = asObject(args['components']);
  if (components) return Object.keys(components);
  for (const key of ['component', 'resource']) {
    const value = args[key];
    if (typeof value === 'string') return [value];
  }
  return [];
}

function extractTypesFromErrorMessage(message: string): string[] {
  for (const pattern of ERROR_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return [match[1]!];
  }
  return [];
}

/** Upstream `method_not_found_message`: extras suffix for -32601. */
export function methodNotFoundSuffix(method: string): string {
  return method.startsWith('brp_extras/')
    ? '. This method requires the bevy_brp_extras crate to be added to your Bevy app with the BrpExtrasPlugin'
    : '';
}

/** Upstream `enhance_error_message`: entity-context rewrite + code suffix. */
function enhanceErrorMessage(args: Record<string, unknown>, message: string, code: number): string {
  if (
    message.includes('Attempting to deserialize an invalid entity') &&
    args['entity'] !== undefined
  ) {
    return `Entity ${String(args['entity'])} is not valid: ${message} (error ${code})`;
  }
  return `${message} (error ${code})`;
}

/**
 * The shared per-tool success shapes. Gesture/input tools carry static
 * messages and no metadata; data tools derive both from the BRP result.
 */
const SHAPES: Record<string, DirectShape> = {
  world_list_components: (result) => ({
    message: `Found ${countOf(result)} components`,
    metadata: { component_count: countOf(result) },
  }),
  world_get_components: (result) => {
    const metadata: Record<string, unknown> = { component_count: countComponents(result) };
    const errorCount = countErrors(result);
    if (errorCount !== undefined) metadata['error_count'] = errorCount;
    return { message: `Retrieved ${metadata['component_count']} components`, metadata };
  },
  world_despawn_entity: (_result, args) => ({ message: `Despawned entity ${param(args, 'entity')}` }),
  world_insert_components: (_result, args) => ({
    message: `Inserted components into entity ${param(args, 'entity')}`,
  }),
  world_remove_components: (_result, args) => ({
    message: `Removed components from entity ${param(args, 'entity')}`,
  }),
  world_mutate_components: (_result, args) => ({
    message: `Mutated ${param(args, 'component')} for entity ${param(args, 'entity')}`,
  }),
  world_query: (result) => ({
    message: `Found ${countOf(result)} entities`,
    metadata: { entity_count: countOf(result), component_count: countQueryComponents(result) },
  }),
  world_spawn_entity: (result) => ({
    message: `Spawned entity ${extractEntity(result)}`,
    metadata: { entity: extractEntity(result) },
  }),
  world_trigger_event: (_result, args) => ({ message: `Triggered event ${param(args, 'event')}` }),
  registry_schema: (result) => ({
    message: `Retrieved ${countOf(result)} schemas`,
    metadata: { type_count: countOf(result) },
  }),
  world_reparent_entities: (_result, args) => ({
    message: `Reparented ${asArray(args['entities'])?.length ?? 0} entities`,
  }),
  rpc_discover: (result) => ({
    message: `Discovered ${countMethods(result)} methods`,
    metadata: { method_count: countMethods(result) },
  }),
  world_list_resources: (result) => ({
    message: `Found ${countOf(result)} resources`,
    metadata: { resource_count: countOf(result) },
  }),
  world_get_resources: (_result, args) => ({ message: `Retrieved ${param(args, 'resource')} resource` }),
  world_insert_resources: (_result, args) => ({ message: `Inserted resource ${param(args, 'resource')}` }),
  world_remove_resources: (_result, args) => ({ message: `Removed resource ${param(args, 'resource')}` }),
  world_mutate_resources: (_result, args) => ({ message: `Mutated resource ${param(args, 'resource')}` }),
  brp_extras_send_keys: (result) => {
    const keysSent = extractArray(result, 'keys_sent').map((key) =>
      typeof key === 'string' ? key : String(key),
    );
    const durationMs = extractDurationMs(result);
    return {
      message: `Sent ${keysSent.length} keys`,
      metadata: { keys_sent: keysSent, duration_ms: durationMs, key_count: keysSent.length },
    };
  },
  brp_extras_type_text: (result) => {
    const rawQueued = asObject(result)?.['chars_queued'];
    const charsQueued = typeof rawQueued === 'number' ? rawQueued : 0;
    const skipped = extractArray(result, 'skipped');
    return {
      message: `Queued ${charsQueued} characters for typing`,
      metadata: { chars_queued: charsQueued, skipped },
    };
  },
  brp_extras_set_window_title: (result) => {
    const status = extractString(result, 'status');
    const oldTitle = extractString(result, 'old_title');
    const newTitle = extractString(result, 'new_title');
    return {
      message: `Window title changed from '${oldTitle}' to '${newTitle}'`,
      metadata: { status, old_title: oldTitle, new_title: newTitle },
    };
  },
  brp_extras_move_mouse: () => ({ message: 'Mouse moved successfully' }),
  brp_extras_send_mouse_button: () => ({ message: 'Mouse button pressed successfully' }),
  brp_extras_click_mouse: () => ({ message: 'Mouse button clicked successfully' }),
  brp_extras_double_click_mouse: () => ({ message: 'Double click executed successfully' }),
  brp_extras_drag_mouse: () => ({ message: 'Drag operation started successfully' }),
  brp_extras_scroll_mouse: () => ({ message: 'Scroll executed successfully' }),
  brp_extras_pinch_gesture: () => ({ message: 'Pinch gesture sent successfully' }),
  brp_extras_rotation_gesture: () => ({ message: 'Rotation gesture sent successfully' }),
  brp_extras_double_tap_gesture: () => ({ message: 'Double tap gesture sent successfully' }),
  brp_extras_get_diagnostics: () => ({ message: 'FPS diagnostics retrieved' }),
};

/** Look up the success shape for a direct tool (all direct tools are covered). */
export function directShape(tool: string): DirectShape {
  return SHAPES[tool] ?? (() => ({ message: 'BRP call succeeded' }));
}

/** The serde-default parameter values upstream materializes into the echo. */
const MATERIALIZED_DEFAULTS: Record<string, Record<string, unknown>> = {
  brp_launch: { instance_count: 1, search_order: 'app' },
  world_find_entities_by_name: { match_mode: 'exact' },
};

/**
 * Parameter echo for the macro-generated direct BRP tools: upstream serializes
 * the typed params (serde defaults materialized) and then silently drops
 * absent optional fields — there is NO `optional_parameters_not_provided`
 * list on this family (verified against the 0.22.3 oracle). Returns `undefined`
 * when upstream loses the echo entirely (`world_mutate_components` without a
 * `path`).
 */
export function directEchoParameters(
  contract: CapturedToolContract,
  provided: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const properties = contract.inputSchema.properties ?? {};
  const echo: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (key === 'port') {
      echo['port'] = typeof provided['port'] === 'number' ? provided['port'] : 15702;
      continue;
    }
    const value = provided[key];
    if (key in provided && value !== null) echo[key] = value;
  }
  if (contract.name === 'world_query') {
    // QueryData's inner `#[serde(default)]` vecs materialize in the echo.
    const data = echo['data'];
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const record = data as Record<string, unknown>;
      record['option'] ??= [];
      record['has'] ??= [];
    }
  }
  if (contract.name === 'world_mutate_components' && !('path' in provided)) {
    return undefined;
  }
  return echo;
}

/**
 * Build the upstream parameter echo from the captured input schema: provided
 * values pass through (explicit nulls count as omitted, like serde `Option`),
 * `#[serde(default)]` fields materialize, and every other absent optional
 * field is listed under `optional_parameters_not_provided`. `port` materializes
 * for every tool that has it.
 */
export function echoParameters(
  contract: CapturedToolContract,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const properties = contract.inputSchema.properties ?? {};
  const keys = Object.keys(properties);
  if (keys.length === 0) return {};
  const required = new Set(contract.inputSchema.required ?? []);
  const echoed: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const key of keys) {
    const materialized =
      key === 'port' ? 15702 : MATERIALIZED_DEFAULTS[contract.name]?.[key];
    if (key in provided) {
      const value = provided[key];
      if (value === null) {
        // Explicit nulls count as omitted (serde Option), except defaulted
        // fields materialize their default instead.
        if (materialized !== undefined) echoed[key] = materialized;
        else omitted.push(key);
        continue;
      }
      echoed[key] = value;
      continue;
    }
    if (materialized !== undefined) echoed[key] = materialized;
    else if (!required.has(key)) omitted.push(key);
  }
  if (omitted.length > 0) echoed['optional_parameters_not_provided'] = omitted;
  return echoed;
}

/**
 * Shape a BRP-level failure the way upstream direct tools do:
 * - method-not-found (-32601) gains the extras suffix, then every message is
 *   suffixed " (error code)" (with the entity-context rewrite);
 * - format-class errors on `enhanced_errors` tools embed a generated type
 *   guide under `metadata` instead of an error code suffix.
 * Transport failures (`BrpHttpError` etc.) keep the owned message.
 */
export async function directBrpErrorExtras(
  services: BevyMcpServices,
  tool: string,
  method: string,
  args: Record<string, unknown>,
  error: unknown,
): Promise<{ message: string; metadata?: Record<string, unknown> }> {
  if (!(error instanceof BrpJsonRpcError)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  let message = error.brpMessage;
  if (message === '') message = error.message; // fakes may omit the raw text
  if (error.code === METHOD_NOT_FOUND) {
    message += methodNotFoundSuffix(method);
  }

  if (ENHANCED_ERROR_TOOLS.has(tool) && FORMAT_ERROR_CODES.has(error.code)) {
    let types = extractTypesFromParams(args);
    if (types.length === 0) types = extractTypesFromErrorMessage(message);
    const { generateTypeGuideResponseFor } = await import('./type-guides/index.js');
    const guide = await generateTypeGuideResponseFor(services, portOf(args), types);
    if (types.length === 0) {
      return {
        message: 'Format error occurred but could not extract type information',
        metadata: {
          original_error: message,
          type_guide: {
            help:
              "Unable to determine specific types that failed. Use the brp_type_guide tool to get spawn/insert/mutation information for the types you're working with.",
            suggested_action: 'Check your BRP method parameters and ensure they match expected structure',
          },
        },
      };
    }
    return {
      message: "Format error - see 'type_guide' field for correct format",
      metadata: { original_error: message, type_guide: guide },
    };
  }

  return { message: enhanceErrorMessage(args, message, error.code) };
}

function portOf(args: Record<string, unknown>): number {
  const port = args['port'];
  return typeof port === 'number' ? port : 15702;
}
