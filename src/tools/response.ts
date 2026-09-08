import type { CallToolResult } from '@modelcontextprotocol/server';

export type ResponseStatus = 'success' | 'error';

export type CallInfo =
  | { mcp_tool: string }
  | { mcp_tool: string; brp_method: string };

/** The upstream-compatible shared response envelope (captured output schema). */
export interface ToolCallJsonResponse {
  status: ResponseStatus;
  message: string;
  call_info: CallInfo;
  metadata?: unknown;
  parameters?: unknown;
  result?: unknown;
  error_info?: unknown;
  brp_extras_debug_info?: unknown;
}

/** Optional envelope fields a tool may attach to its response. */
export interface ToolResponseExtras {
  metadata?: unknown;
  parameters?: unknown;
  result?: unknown;
  error_info?: unknown;
  brp_extras_debug_info?: unknown;
}

/** The envelope fields that are only emitted when present. */
type OptionalEnvelopeFields = Partial<
  Pick<ToolCallJsonResponse, 'metadata' | 'parameters' | 'result' | 'error_info' | 'brp_extras_debug_info'>
>;

/** Upstream normalization of tool parameters: top-level `null` optional
 * parameters are removed and their names appended under
 * `optional_parameters_not_provided` inside `parameters`.
 */
function normalizeParameters(parameters: unknown): unknown {
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return parameters;
  }
  const entries = Object.entries(parameters as Record<string, unknown>);
  const omitted = entries.filter(([, value]) => value === null).map(([key]) => key);
  if (omitted.length === 0) {
    return parameters;
  }
  return {
    ...Object.fromEntries(entries.filter(([, value]) => value !== null)),
    optional_parameters_not_provided: omitted,
  };
}

function envelopeFields(extras: ToolResponseExtras): OptionalEnvelopeFields {
  const response: OptionalEnvelopeFields = {};
  if (extras.metadata !== undefined) response.metadata = extras.metadata;
  if (extras.parameters !== undefined) response.parameters = normalizeParameters(extras.parameters);
  if (extras.result !== undefined) response.result = extras.result;
  if (extras.error_info !== undefined) response.error_info = extras.error_info;
  if (extras.brp_extras_debug_info !== undefined) {
    response.brp_extras_debug_info = extras.brp_extras_debug_info;
  }
  return response;
}

function toCallToolResult(response: ToolCallJsonResponse): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    structuredContent: response,
  };
}

/** Build a successful envelope CallToolResult. */
export function toolSuccess(
  callInfo: CallInfo,
  message: string,
  extras: ToolResponseExtras = {},
): CallToolResult {
  return toCallToolResult({
    status: 'success',
    message,
    call_info: callInfo,
    ...envelopeFields(extras),
  });
}

/** Build an error envelope CallToolResult (MCP isError set). */
export function toolError(
  callInfo: CallInfo,
  message: string,
  extras: ToolResponseExtras = {},
): CallToolResult {
  return {
    ...toCallToolResult({
      status: 'error',
      message,
      call_info: callInfo,
      ...envelopeFields(extras),
    }),
    isError: true,
  };
}
