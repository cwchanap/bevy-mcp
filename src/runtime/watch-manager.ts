import { DEFAULT_BRP_PORT, type BrpClient } from '../brp/client.js';
import { BrpPrecisionError } from '../brp/errors.js';
import { assertSafeIntegers } from '../brp/safe-json.js';
import { appendRecord, type LogStore } from './log-store.js';

/**
 * Native Bevy watch management over `world.get_components+watch` /
 * `world.list_components+watch` SSE streams. Translated from upstream
 * `bevy_brp_mcp` 0.22.3 `src/brp_tools/watch_tools/` (task.rs, manager.rs,
 * logger.rs), MIT licensed: same BRP methods, record event names, and log
 * line format, backed by the repository-owned LogStore and abort-based
 * lifecycle instead of spawned tasks.
 */

export type WatchKind = 'get_components' | 'list_components';

/** One active watch registration, mirroring the task-brief interface. */
export interface ActiveWatch {
  id: number;
  kind: WatchKind;
  entity: number;
  types?: string[];
  port: number;
  filename: string;
  path: string;
}

/** Watch info as exposed by `brp_list_active_watches` (upstream field names). */
export interface ActiveWatchInfo {
  watch_id: number;
  entity_id: number;
  watch_type: 'get' | 'list';
  log_path: string;
  port: number;
}

/** Exact Bevy BRP method per watch kind (`+watch` native streams). */
const WATCH_METHODS: Record<WatchKind, string> = {
  get_components: 'world.get_components+watch',
  list_components: 'world.list_components+watch',
};

/** Public watch_type token used in filenames and list output (upstream). */
const WATCH_TYPES: Record<WatchKind, 'get' | 'list'> = {
  get_components: 'get',
  list_components: 'list',
};

/** Upstream SSE framing prefix (`constants.rs`, space included). */
const SSE_DATA_PREFIX = 'data: ';

interface ActiveEntry extends ActiveWatch {
  controller: AbortController;
  /** Serializes log appends so records keep stream order end-to-end. */
  pending: Promise<void>;
}

/**
 * Split an SSE byte stream into lines across arbitrary chunk boundaries
 * (LF endings, trailing CR stripped, final partial line via `flush`).
 */
export class SseLineSplitter {
  #buffer = '';

  /** Feed one decoded chunk; returns every complete line it completed. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
    }
    return lines;
  }

  /** The trailing line if the stream ended mid-line (trimmed), else nothing. */
  flush(): string | undefined {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest === '' ? undefined : rest;
  }
}

export type ParsedSseLine =
  | { ok: true; result: unknown }
  | { ok: false }
  | { ok: false; unsafe: true; error: string };

/**
 * Parse one SSE line. Only `data: {json}` lines whose JSON-RPC response
 * carries a `result` produce an update record; non-data lines, malformed
 * JSON, and error responses are skipped without failing the stream. A record
 * carrying an unsafe 64-bit integer is NOT silently logged: it is reported
 * (`unsafe`) with the failing path so the pump can surface an error record —
 * same fail-loud rule as instant calls — while the stream stays alive.
 */
export function parseSseDataLine(line: string): ParsedSseLine {
  if (!line.startsWith(SSE_DATA_PREFIX)) return { ok: false };
  let data: unknown;
  try {
    data = JSON.parse(line.slice(SSE_DATA_PREFIX.length));
  } catch {
    return { ok: false };
  }
  if (data === null || typeof data !== 'object' || !('result' in data)) return { ok: false };
  const result = (data as { result?: unknown }).result;
  if (result === undefined) return { ok: false };
  try {
    assertSafeIntegers(data, 'watch', 'record');
  } catch (error) {
    if (error instanceof BrpPrecisionError)
      return {
        ok: false,
        unsafe: true,
        // Name the path only: the corrupted float is never reproduced, so it
        // cannot land in the log masquerading as the real 64-bit value.
        error: `Watch record contained an unsafe integer at ${error.path}; the value was dropped to avoid 64-bit precision loss.`,
      };
    throw error;
  }
  return { ok: true, result };
}

/**
 * Owns active watch subscriptions: monotonic IDs from 1, background stream
 * pumping with per-watch AbortControllers, and best-effort log records
 * (WATCH_STARTED, COMPONENT_UPDATE, CONNECTION_ERROR, WATCH_ENDED).
 */
export class WatchManager {
  #nextId = 1;
  readonly #active = new Map<number, ActiveEntry>();

  constructor(
    private readonly logStore: LogStore,
    private readonly brp: BrpClient,
  ) {}

  /** Start a get-components watch; `types` must be a non-empty array. */
  async startGetComponents(entity: number, types: string[], port = DEFAULT_BRP_PORT): Promise<ActiveWatch> {
    if (!Array.isArray(types) || types.length === 0) {
      throw new Error('components array cannot be empty. Specify at least one component to watch');
    }
    return this.#start('get_components', entity, types, port);
  }

  /** Start a list-components watch for one entity. */
  async startListComponents(entity: number, port = DEFAULT_BRP_PORT): Promise<ActiveWatch> {
    return this.#start('list_components', entity, undefined, port);
  }

  /** Snapshot of the active watches (upstream `brp_list_active` shape). */
  list(): ActiveWatchInfo[] {
    return [...this.#active.values()].map((watch) => this.#toInfo(watch));
  }

  /** Abort one watch; `false` when the ID is unknown (tool error upstream). */
  stop(id: number): boolean {
    const watch = this.#active.get(id);
    if (watch === undefined) return false;
    this.#active.delete(id);
    watch.controller.abort();
    return true;
  }

  /** Abort every active watch (session shutdown step 1). */
  async stopAll(): Promise<void> {
    const watches = [...this.#active.values()];
    this.#active.clear();
    for (const watch of watches) watch.controller.abort();
  }

  async #start(
    kind: WatchKind,
    entity: number,
    types: string[] | undefined,
    port: number,
  ): Promise<ActiveWatch> {
    // ID is consumed first because the log filename carries it; the watch is
    // only REGISTERED once the HTTP stream is established successfully.
    const id = this.#nextId++;
    const watchType = WATCH_TYPES[kind];
    const { filename, path } = await this.logStore.createWatchLog(id, entity, watchType);

    const controller = new AbortController();
    const params: Record<string, unknown> =
      types === undefined ? { entity } : { entity, components: types };
    let response: Response;
    try {
      response = await this.brp.stream(WATCH_METHODS[kind], params, {
        port,
        signal: controller.signal,
      });
    } catch (error) {
      await appendRecord(path, 'CONNECTION_ERROR', {
        watch_type: watchType,
        entity,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    const entry: ActiveEntry = {
      id,
      kind,
      entity,
      ...(types !== undefined && { types }),
      port,
      filename,
      path,
      controller,
      pending: Promise.resolve(),
    };
    await appendRecord(path, 'WATCH_STARTED', { ...params, port, timestamp: new Date().toISOString() });
    this.#active.set(id, entry);
    void this.#pump(entry, response);
    return this.#toActive(entry);
  }

  /** Background stream loop: append update records until end/error/abort. */
  async #pump(entry: ActiveEntry, response: Response): Promise<void> {
    // Every record append chains onto the entry's queue: update/error records
    // are persisted in stream order and WATCH_ENDED is written last.
    const enqueue = (updateType: string, data: unknown): void => {
      entry.pending = entry.pending.then(() => appendRecord(entry.path, updateType, data));
    };
    const onLine = (line: string): void => {
      const parsed = parseSseDataLine(line);
      if (parsed.ok) {
        enqueue('COMPONENT_UPDATE', parsed.result);
      } else if ('unsafe' in parsed) {
        enqueue('ERROR', {
          watch_type: WATCH_TYPES[entry.kind],
          entity: entry.entity,
          error: parsed.error,
          timestamp: new Date().toISOString(),
        });
      }
    };
    const splitter = new SseLineSplitter();
    try {
      const body = response.body;
      if (body !== null) {
        const decoder = new TextDecoder();
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            for (const line of splitter.push(decoder.decode(value, { stream: true }))) onLine(line);
          }
        }
        const rest = decoder.decode();
        if (rest !== '') {
          for (const line of splitter.push(rest)) onLine(line);
        }
      }
      const tail = splitter.flush();
      if (tail !== undefined) onLine(tail);
    } catch (error) {
      if (!entry.controller.signal.aborted) {
        enqueue('CONNECTION_ERROR', {
          watch_type: WATCH_TYPES[entry.kind],
          entity: entry.entity,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    }
    await entry.pending;
    await appendRecord(entry.path, 'WATCH_ENDED', {
      entity: entry.entity,
      timestamp: new Date().toISOString(),
    });
    this.#remove(entry.id, entry);
  }

  /** Remove only if this exact entry is still registered (stop races). */
  #remove(id: number, entry: ActiveEntry): void {
    if (this.#active.get(id) === entry) this.#active.delete(id);
  }

  #toActive(entry: ActiveEntry): ActiveWatch {
    const { controller: _controller, ...watch } = entry;
    return watch;
  }

  #toInfo(entry: ActiveEntry): ActiveWatchInfo {
    return {
      watch_id: entry.id,
      entity_id: entry.entity,
      watch_type: WATCH_TYPES[entry.kind],
      log_path: entry.path,
      port: entry.port,
    };
  }
}
