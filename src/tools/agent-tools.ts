import { DEFAULT_BRP_PORT } from '../brp/client.js';
import { BrpError, BrpJsonRpcError } from '../brp/errors.js';
import { methodNotFoundSuffix } from './brp-shape.js';
import type { BevyMcpServices } from '../services.js';
import { brpErrorInfo, toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/** Method names from an `rpc.discover` document. Mirrors upstream's typed
 * `serde_json::from_value::<OpenRpcDocument>` decode (bevy_remote 0.19.1
 * `schemas/open_rpc.rs`, MIT): `openrpc`, `info.title`/`info.version`, and
 * `methods` are required; `servers` and each method's `summary`/`description`/
 * `params` are type-checked when present (a `Parameter` requires `name` and a
 * `JsonSchemaBevyType` `schema`). A document failing the typed decode is a
 * decode failure — never an empty catalog (which would misreport the
 * requested method as unregistered). */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** serde `Option<String>`-shaped: absent, null, or a string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** serde `Vec<String>`-shaped. */
function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Serde variant spellings of bevy_remote's `SchemaKind`, `SchemaType`
 * (rename_all = "lowercase"), `StorageKind`, and `RelationshipKind`. */
const SCHEMA_KINDS = new Set([
  'Struct',
  'Enum',
  'Map',
  'Array',
  'List',
  'Tuple',
  'TupleStruct',
  'Set',
  'Value',
]);
const SCHEMA_TYPES = new Set([
  'string',
  'float',
  'uint',
  'int',
  'object',
  'array',
  'boolean',
  'set',
  'null',
]);
const STORAGE_KINDS = new Set(['Table', 'SparseSet']);
const RELATIONSHIP_KINDS = new Set(['Relationship', 'RelationshipTarget']);

/** `ComponentMetadata` decode: `mutable`/`storageType`/`isSendAndSync`
 * required; `requiredComponentTypes`/`relationshipKind` checked when present. */
function isComponentMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['mutable'] !== 'boolean') return false;
  if (typeof value['storageType'] !== 'string' || !STORAGE_KINDS.has(value['storageType'])) {
    return false;
  }
  if (typeof value['isSendAndSync'] !== 'boolean') return false;
  if (
    value['requiredComponentTypes'] !== undefined &&
    !isStringArray(value['requiredComponentTypes'])
  ) {
    return false;
  }
  const relationshipKind = value['relationshipKind'];
  return (
    relationshipKind === undefined ||
    relationshipKind === null ||
    (typeof relationshipKind === 'string' && RELATIONSHIP_KINDS.has(relationshipKind))
  );
}

/** `JsonSchemaBevyType` decode: `shortPath`/`typePath`/`kind`/`type`
 * required (enums checked); typed optionals checked when present. `keyType`,
 * `valueType`, and `items` are `Option<serde_json::Value>` — anything goes. */
function isJsonSchemaBevyType(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['shortPath'] !== 'string') return false;
  if (typeof value['typePath'] !== 'string') return false;
  if (typeof value['kind'] !== 'string' || !SCHEMA_KINDS.has(value['kind'])) return false;
  if (typeof value['type'] !== 'string' || !SCHEMA_TYPES.has(value['type'])) return false;
  if (!isOptionalString(value['modulePath']) || !isOptionalString(value['crateName'])) {
    return false;
  }
  if (value['reflectTypes'] !== undefined && !isStringArray(value['reflectTypes'])) return false;
  if (value['required'] !== undefined && !isStringArray(value['required'])) return false;
  const additionalProperties = value['additionalProperties'];
  if (
    additionalProperties !== undefined &&
    additionalProperties !== null &&
    typeof additionalProperties !== 'boolean'
  ) {
    return false;
  }
  const componentInfo = value['componentInfo'];
  if (componentInfo !== undefined && componentInfo !== null && !isComponentMetadata(componentInfo)) {
    return false;
  }
  if (value['properties'] !== undefined && !isRecord(value['properties'])) return false;
  if (value['oneOf'] !== undefined && !Array.isArray(value['oneOf'])) return false;
  if (value['prefixItems'] !== undefined && !Array.isArray(value['prefixItems'])) return false;
  return true;
}

/** `Parameter` decode: `name` and `schema` required; `description` checked
 * when present. */
function isParameter(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['name'] !== 'string') return false;
  if (!isOptionalString(value['description'])) return false;
  return isJsonSchemaBevyType(value['schema']);
}

/** `Vec<ServerObject>` decode: each entry requires string `name`/`url`. */
function isServerArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (server) =>
        isRecord(server) &&
        typeof server['name'] === 'string' &&
        typeof server['url'] === 'string' &&
        isOptionalString(server['description']),
    )
  );
}

function discoveredMethods(document: unknown): string[] {
  if (!isRecord(document)) {
    throw new Error('rpc.discover document is not an object with a methods array');
  }
  if (typeof document['openrpc'] !== 'string') {
    throw new Error('rpc.discover document is missing required field `openrpc`');
  }
  const info = document['info'];
  if (
    !isRecord(info) ||
    typeof info['title'] !== 'string' ||
    typeof info['version'] !== 'string' ||
    !isOptionalString(info['description'])
  ) {
    throw new Error('rpc.discover document `info` is not an object with string `title`/`version`');
  }
  const servers = document['servers'];
  if (servers !== undefined && servers !== null && !isServerArray(servers)) {
    throw new Error('rpc.discover document `servers` is not a list of server objects');
  }
  const methods = document['methods'];
  if (!Array.isArray(methods)) {
    throw new Error('rpc.discover document is not an object with a methods array');
  }
  return methods.map((entry, index) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      throw new Error(`rpc.discover method entry ${index} has no string name`);
    }
    if (!isOptionalString(entry['summary']) || !isOptionalString(entry['description'])) {
      throw new Error(`rpc.discover method entry ${index} has non-string summary/description`);
    }
    const params = entry['params'];
    if (params !== undefined && (!Array.isArray(params) || !params.every(isParameter))) {
      throw new Error(`rpc.discover method entry ${index} has malformed params`);
    }
    if (entry['name'] === '') {
      throw new Error('rpc.discover returned an empty method name');
    }
    return entry['name'];
  });
}

/**
 * `brp_execute`: validate the requested method against a live `rpc.discover`,
 * then invoke it through `BrpClient`. This handler is registered standalone;
 * no other handler may import or call it (it is never a fallback).
 */
export function executeHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const method = args.method as string;
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    const callInfo = { mcp_tool: 'brp_execute' } as const;

    let available: string[];
    try {
      available = discoveredMethods(await services.brp.discover(port));
    } catch (error) {
      if (!(error instanceof BrpError)) {
        // A validation throw is the OpenRpcDocument decode failure upstream
        // reports — same `stage: 'discovery'` metadata, different message.
        return toolError(
          callInfo,
          `Unable to decode rpc.discover response from port ${port}`,
          {
            metadata: {
              stage: 'discovery',
              port,
              error: error instanceof Error ? error.message : String(error),
            },
          },
        );
      }
      return toolError(callInfo, `Failed to discover BRP methods on port ${port}`, {
        metadata: { stage: 'discovery', port, error: error.message },
      });
    }

    if (!available.includes(method)) {
      const message = `BRP method \`${method}\` is not registered on port ${port}`;
      return toolError(callInfo, message + methodNotFoundSuffix(method), {
        metadata: {
          stage: 'discovery',
          method,
          port,
          available_methods: [...available].sort(),
        },
      });
    }

    try {
      const params = 'params' in args ? args.params : undefined;
      const result = await services.brp.call(method, params, { port });
      return toolSuccess(callInfo, `Executed method ${method}`, {
        ...(result !== undefined && result !== null ? { result } : {}),
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      if (error instanceof BrpJsonRpcError) {
        // Upstream `brp_execute` runs through `execute_raw`, so failures keep
        // the raw BRP message (plus the extras suffix for -32601) and surface
        // the details under `metadata` (stage: execution).
        const message =
          error.code === -32601 ? error.brpMessage + methodNotFoundSuffix(method) : error.brpMessage;
        return toolError(callInfo, message, {
          metadata: {
            stage: 'execution',
            method,
            port,
            code: error.code,
            ...(error.data !== undefined && error.data !== null ? { data: error.data } : {}),
          },
        });
      }
      // Non-JSON-RPC transport failure (timeout, abort, HTTP, malformed
      // body): the same standard error envelope as every other failure path,
      // never a raw rethrow.
      return toolError(callInfo, error.message, {
        metadata: { stage: 'execution', method, port },
        error_info: brpErrorInfo(error),
      });
    }
  };
}

/** Upstream injects these instructions into the public result under `usage`. */
const AGENT_TOOLS_USAGE = "Pass an entry's method and matching params to brp_execute.";

/**
 * `brp_list_agent_tools`: fetch the application-published curated catalog via
 * `brp_extras/agent_tools`, inject the public `result.usage` instructions, and
 * preserve the rest of the result verbatim.
 */
export function listAgentToolsHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const port = typeof args.port === 'number' ? args.port : DEFAULT_BRP_PORT;
    const callInfo = { mcp_tool: 'brp_list_agent_tools' } as const;

    try {
      const fetched = await services.brp.call('brp_extras/agent_tools', undefined, { port });
      // Upstream decodes the catalog wire shape and re-publishes exactly
      // `{usage, tools}` — the wire `version` envelope is not part of the
      // public result. A response that is not an object carrying a tools
      // array is a malformed catalog: fail like a fetch failure rather than
      // reporting a successful empty list.
      const tools =
        fetched !== null && typeof fetched === 'object'
          ? (fetched as Record<string, unknown>)['tools']
          : undefined;
      if (!Array.isArray(tools)) {
        return toolError(callInfo, `Unable to fetch the agent tool catalog from port ${port}`, {
          metadata: {
            stage: 'catalog_fetch',
            method: 'brp_extras/agent_tools',
            port,
            error: 'catalog response is not an object with a tools array',
          },
        });
      }
      const result = { usage: AGENT_TOOLS_USAGE, tools };
      const count = tools.length;
      return toolSuccess(callInfo, `Listed ${count} agent tools`, {
        metadata: { tool_count: count },
        result,
      });
    } catch (error) {
      if (!(error instanceof BrpError)) throw error;
      const metadata: Record<string, unknown> = {
        stage: 'catalog_fetch',
        method: 'brp_extras/agent_tools',
        port,
        error: error.message,
      };
      if (error instanceof BrpJsonRpcError) metadata.code = error.code;
      return toolError(callInfo, `Unable to fetch the agent tool catalog from port ${port}`, {
        metadata,
      });
    }
  };
}
