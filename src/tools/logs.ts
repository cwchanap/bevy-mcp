import type { BevyMcpServices } from '../services.js';
import { toolError, toolSuccess } from './response.js';
import type { OwnedToolHandler } from './register.js';

/**
 * The three log tools with their EXACT public contracts: only the captured
 * parameters are read — no log tool accepts `port` or caller-supplied paths,
 * and extra keys are ignored (the captured schemas have no
 * `additionalProperties: false`). Everything else delegates to LogStore.
 */

function intOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `brp_list_logs {app_name?, verbose?}` -> LogStore.list. */
export function listLogsHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_list_logs' } as const;
    try {
      const logs = await services.logStore.list({
        appName: strOrUndefined(args.app_name),
        verbose: args.verbose === true,
      });
      return toolSuccess(callInfo, `Found ${logs.length} log files`, {
        metadata: { log_count: logs.length },
        result: { logs },
        parameters: args,
      });
    } catch (error) {
      return toolError(callInfo, error instanceof Error ? error.message : String(error), {
        parameters: args,
      });
    }
  };
}

/** `brp_read_log {filename, keyword?, tail_lines?}` -> LogStore.read. */
export function readLogHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_read_log' } as const;
    const filename = strOrUndefined(args.filename);
    if (filename === undefined) {
      return toolError(callInfo, 'filename is required', { parameters: args });
    }
    try {
      const read = await services.logStore.read(filename, {
        keyword: strOrUndefined(args.keyword),
        tailLines: intOrUndefined(args.tail_lines),
      });
      return toolSuccess(callInfo, `Read ${read.lines_read} lines from ${read.filename}`, {
        metadata: {
          filename: read.filename,
          file_path: read.file_path,
          size_bytes: read.size_bytes,
          size_human: read.size_human,
          lines_read: read.lines_read,
          filtered_by_keyword: read.filtered_by_keyword,
          tail_mode: read.tail_mode,
        },
        result: read.content,
        parameters: args,
      });
    } catch (error) {
      // Includes LogStore's traversal/absolute-path rejection.
      return toolError(callInfo, error instanceof Error ? error.message : String(error), {
        parameters: args,
      });
    }
  };
}

/** `brp_delete_logs {app_name?, older_than_seconds?}` -> LogStore.delete. */
export function deleteLogsHandler(services: BevyMcpServices): OwnedToolHandler {
  return async (args) => {
    const callInfo = { mcp_tool: 'brp_delete_logs' } as const;
    const appName = strOrUndefined(args.app_name);
    const olderThanSeconds = intOrUndefined(args.older_than_seconds);
    try {
      const deleted = await services.logStore.delete({ appName, olderThanSeconds });
      return toolSuccess(callInfo, `Deleted ${deleted.length} log files`, {
        metadata: {
          deleted_files: deleted,
          deleted_count: deleted.length,
          ...(appName !== undefined ? { app_name_filter: appName } : {}),
          ...(olderThanSeconds !== undefined ? { older_than_seconds: olderThanSeconds } : {}),
        },
        parameters: args,
      });
    } catch (error) {
      return toolError(callInfo, error instanceof Error ? error.message : String(error), {
        parameters: args,
      });
    }
  };
}
