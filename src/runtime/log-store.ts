import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Repository-owned log storage. LogStore ALONE owns the absolute log roots
 * `<tmp>/bevy-mcp/apps` and `<tmp>/bevy-mcp/watches`; tool callers only ever
 * pass bare filenames and app-name filters, never paths or ports.
 *
 * Log naming and the record line format are translated from upstream
 * `bevy_brp_mcp` 0.22.3 (`src/brp_tools/watch_tools/logger.rs` and
 * `src/log_tools/`), MIT licensed, with the retired upstream `bevy_brp_mcp`
 * filename prefix replaced by the repository-owned `bevy-mcp` prefix — the
 * same substitution the reviewed CONTRACT_OVERRIDES apply to captured tool
 * descriptions. Watch logs are `bevy-mcp_watch_{watch_id}_{watch_type}_{entity_id}_{timestamp}.log`;
 * app logs are `bevy-mcp_{app_name}_{timestamp}.log`.
 */

/** Filename prefix and extension shared by every owned log file. */
const LOG_PREFIX = 'bevy-mcp_';
const LOG_EXTENSION = '.log';

const APPS_DIR = 'apps';
const WATCHES_DIR = 'watches';

/** Upstream 0.22.3 `log_tools/constants.rs` byte-formatting table (MIT). */
const BYTES_PER_UNIT = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** One listed log file. Verbose-only fields are `undefined` otherwise. */
export interface LogFileInfo {
  filename: string;
  app_name: string;
  path?: string;
  size?: string;
  size_bytes?: number;
  created?: string;
  modified?: string;
}

/** Upstream-compatible `brp_read_log` result fields (flat; callers split
 * `content` into `result` and the rest into `metadata`). */
export interface ReadLogResult {
  filename: string;
  file_path: string;
  size_bytes: number;
  size_human: string;
  lines_read: number;
  content: string;
  /** Upstream serializes both modes as booleans (`serde(from/into = "bool")`). */
  filtered_by_keyword: boolean;
  tail_mode: boolean;
}

interface LogEntry {
  filename: string;
  path: string;
  appName: string;
  timestamp: number;
  /** App logs live under `apps`; watch logs under `watches`. */
  isAppLog: boolean;
  sizeBytes: number;
  created: Date;
  modified: Date;
}

/** Local-time log prefix, upstream `%Y-%m-%d %H:%M:%S%.3f` (with millis). */
export function formatLogTimestamp(date = new Date(), millis = true): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return millis ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}

/** Human-readable size, ported from upstream `log_tools/support.rs`. */
export function formatBytes(bytes: number): string {
  let size = bytes;
  let unitIndex = 0;
  while (size >= BYTES_PER_UNIT && unitIndex < UNITS.length - 1) {
    size /= BYTES_PER_UNIT;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${bytes} ${UNITS[unitIndex]}` : `${size.toFixed(2)} ${UNITS[unitIndex]}`;
}

/** Replace anything outside the safe filename alphabet (incl. separators). */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned === '' ? 'app' : cleaned;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse `bevy-mcp_..._{timestamp}.log` into app name and timestamp, mirroring
 * upstream's generic parse (strip prefix/extension, split at the final `_`).
 */
function parseLogFilename(filename: string): { appName: string; timestamp: number } | undefined {
  if (!isValidLogFilename(filename)) return undefined;
  const core = filename.slice(LOG_PREFIX.length, -LOG_EXTENSION.length);
  const split = core.lastIndexOf('_');
  if (split <= 0) return undefined;
  const timestamp = Number(core.slice(split + 1));
  return { appName: core.slice(0, split), timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
}

/** Upstream security check: prefix + extension, nothing else (no paths). */
function isValidLogFilename(filename: string): boolean {
  return filename.startsWith(LOG_PREFIX) && filename.endsWith(LOG_EXTENSION);
}

/**
 * Append one `[timestamp] TYPE: json` record. Best-effort like upstream's
 * `let _ = logger.write_update(...)`: failures never break the caller.
 */
export async function appendRecord(path: string, updateType: string, data: unknown): Promise<void> {
  try {
    const line = `[${formatLogTimestamp()}] ${updateType}: ${JSON.stringify(data)}\n`;
    await appendFile(path, line);
  } catch {
    // Logging must never break a watch or tool call.
  }
}

/** Allocate uniquely-named app/watch log files under the owned roots. */
export class LogStore {
  /** Default root is the production `<tmp>/bevy-mcp`; tests inject a base. */
  constructor(private readonly root: string = join(tmpdir(), 'bevy-mcp')) {}

  /** The absolute log root all log files live under. */
  get directory(): string {
    return this.root;
  }

  private get appsRoot(): string {
    return join(this.root, APPS_DIR);
  }

  private get watchesRoot(): string {
    return join(this.root, WATCHES_DIR);
  }

  /** Allocate an app log file for `appName`. */
  async createAppLog(appName: string): Promise<{ filename: string; path: string }> {
    return this.#allocate(this.appsRoot, `${LOG_PREFIX}${sanitizeName(appName)}`);
  }

  /**
   * Allocate a watch log named exactly per the captured contract text:
   * `bevy-mcp_watch_{watch_id}_{watch_type}_{entity_id}_{timestamp}.log`.
   * `kind` is the public watch type: `get` or `list`.
   */
  async createWatchLog(
    watchId: number,
    entity: number,
    kind: 'get' | 'list',
  ): Promise<{ filename: string; path: string }> {
    return this.#allocate(
      this.watchesRoot,
      `${LOG_PREFIX}watch_${watchId}_${kind}_${entity}`,
    );
  }

  /**
   * List log files newest first. `appName` filters app logs only (watch logs
   * never match, like upstream); `verbose` adds path/size/mtime metadata.
   */
  async list(options: { appName?: string; verbose?: boolean } = {}): Promise<LogFileInfo[]> {
    const entries = await this.#entries();
    const filtered = options.appName === undefined
      ? entries
      : entries.filter((entry) => entry.isAppLog && entry.appName === options.appName);
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered.map((entry) => this.#toInfo(entry, options.verbose === true));
  }

  /**
   * Read one bare log filename from the owned roots. Rejects traversal,
   * absolute paths, and anything that is not exactly an owned filename.
   */
  async read(
    filename: string,
    options: { keyword?: string; tailLines?: number } = {},
  ): Promise<ReadLogResult> {
    if (
      typeof filename !== 'string' ||
      !isValidLogFilename(filename) ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      throw new Error('only bevy-mcp log files can be read');
    }
    const path = this.#resolveOwned(filename);
    if (path === undefined) {
      throw new Error(`log file '${filename}' not found`);
    }

    const [raw, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const split = raw.split('\n');
    if (split[split.length - 1] === '') split.pop();
    let lines = split.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

    const keyword = options.keyword;
    if (keyword !== undefined) {
      const needle = keyword.toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(needle));
    }

    // Upstream tail: only when 0 < tail < line count.
    const tailLines = options.tailLines;
    if (
      typeof tailLines === 'number' &&
      Number.isInteger(tailLines) &&
      tailLines > 0 &&
      tailLines < lines.length
    ) {
      lines = lines.slice(lines.length - tailLines);
    }

    return {
      filename,
      file_path: path,
      size_bytes: metadata.size,
      size_human: formatBytes(metadata.size),
      lines_read: lines.length,
      content: lines.join('\n'),
      filtered_by_keyword: keyword !== undefined,
      tail_mode: tailLines !== undefined,
    };
  }

  /**
   * Delete logs by app name (app logs only) and modification age; returns
   * the deleted filenames. No filters removes everything, watch logs included.
   */
  async delete(options: { appName?: string; olderThanSeconds?: number } = {}): Promise<string[]> {
    const entries = await this.#entries();
    const cutoff =
      options.olderThanSeconds === undefined ? undefined : Date.now() - options.olderThanSeconds * 1000;
    const deleted: string[] = [];
    for (const entry of entries) {
      if (options.appName !== undefined && !(entry.isAppLog && entry.appName === options.appName)) {
        continue;
      }
      if (cutoff !== undefined && entry.modified.getTime() > cutoff) continue;
      try {
        await unlink(entry.path);
      } catch {
        continue;
      }
      deleted.push(entry.filename);
    }
    return deleted;
  }

  /** Create `prefix_{timestamp}.log`, bumping the second on any collision. */
  async #allocate(dir: string, prefix: string): Promise<{ filename: string; path: string }> {
    await mkdir(dir, { recursive: true });
    let timestamp = epochSeconds();
    let filename = `${prefix}_${timestamp}${LOG_EXTENSION}`;
    while (existsSync(join(dir, filename))) {
      timestamp += 1;
      filename = `${prefix}_${timestamp}${LOG_EXTENSION}`;
    }
    const path = join(dir, filename);
    await writeFile(path, '');
    return { filename, path };
  }

  /** Resolve a validated bare filename to an owned root path, if present. */
  #resolveOwned(filename: string): string | undefined {
    for (const dir of [this.appsRoot, this.watchesRoot]) {
      const path = join(dir, filename);
      if (existsSync(path)) return path;
    }
    return undefined;
  }

  async #entries(): Promise<LogEntry[]> {
    const roots: { dir: string; isAppLog: boolean }[] = [
      { dir: this.appsRoot, isAppLog: true },
      { dir: this.watchesRoot, isAppLog: false },
    ];
    const entries: LogEntry[] = [];
    for (const { dir, isAppLog } of roots) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const filename of names) {
        const parsed = parseLogFilename(filename);
        if (parsed === undefined) continue;
        const path = join(dir, filename);
        try {
          const metadata = await stat(path);
          if (!metadata.isFile()) continue;
          entries.push({
            filename,
            path,
            appName: parsed.appName,
            timestamp: parsed.timestamp,
            isAppLog,
            sizeBytes: metadata.size,
            created: metadata.birthtimeMs > 0 ? metadata.birthtime : metadata.mtime,
            modified: metadata.mtime,
          });
        } catch {
          continue;
        }
      }
    }
    return entries;
  }

  #toInfo(entry: LogEntry, verbose: boolean): LogFileInfo {
    const info: LogFileInfo = { filename: entry.filename, app_name: entry.appName };
    if (verbose) {
      info.path = entry.path;
      info.size = formatBytes(entry.sizeBytes);
      info.size_bytes = entry.sizeBytes;
      info.created = formatLogTimestamp(entry.created, false);
      info.modified = formatLogTimestamp(entry.modified, false);
    }
    return info;
  }
}
