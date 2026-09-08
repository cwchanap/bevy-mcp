import {
  BrpAbortError,
  BrpError,
  BrpHttpError,
  BrpJsonRpcError,
  BrpMalformedResponseError,
  BrpPrecisionError,
  BrpTimeoutError,
} from './errors.js';
import type { BrpJsonRpcRequest, BrpJsonRpcResponse } from './types.js';

/** Bevy's BRP HTTP endpoint listens on localhost at this port by default. */
export const DEFAULT_BRP_PORT = 15702;

/** Timeout applied to ordinary instant calls; streaming requests get none. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BrpCallOptions {
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * JSON-RPC 2.0 client for Bevy's BRP HTTP endpoint. One POST per call —
 * no retry, no method cache.
 */
export class BrpClient {
  private nextId = 1;

  /** Instant JSON-RPC call: resolves the `result` or rejects with a typed `BrpError`. */
  async call<T>(method: string, params?: unknown, options: BrpCallOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const response = await this.post(method, params, options, timeoutMs);
    if (!response.ok) {
      await drain(response);
      throw new BrpHttpError(response.status, response.statusText);
    }
    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (cause) {
      throw new BrpMalformedResponseError(method, { cause });
    }
    assertSafeIntegers(decoded, method, 'result');
    const envelope = decoded as BrpJsonRpcResponse;
    if (envelope !== null && typeof envelope === 'object' && envelope.error !== undefined) {
      throw new BrpJsonRpcError(
        method,
        envelope.error.code,
        envelope.error.message,
        envelope.error.data,
      );
    }
    return envelope.result as T;
  }

  /**
   * Streaming request (native `+watch` SSE): resolves the raw successful
   * `Response` once headers are established. No timeout is applied; the
   * caller abort signal is forwarded and governs the body. SSE parsing
   * belongs to the watch layer, not here.
   */
  async stream(
    method: string,
    params: unknown,
    options: Omit<BrpCallOptions, 'timeoutMs'> = {},
  ): Promise<Response> {
    const response = await fetch(this.endpointUrl(options.port), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.request(method, params)),
      signal: options.signal,
    });
    if (!response.ok) {
      await drain(response);
      throw new BrpHttpError(response.status, response.statusText);
    }
    return response;
  }

  /** Instant `rpc.discover` of the live BRP method catalog. */
  async discover(port?: number): Promise<unknown> {
    return this.call('rpc.discover', undefined, { port });
  }

  private async post(
    method: string,
    params: unknown,
    options: BrpCallOptions,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      return await fetch(this.endpointUrl(options.port), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.request(method, params)),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) throw new BrpTimeoutError(method, timeoutMs);
      if (options.signal?.aborted) throw new BrpAbortError(method);
      throw new BrpError(
        `BRP call '${method}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private endpointUrl(port = DEFAULT_BRP_PORT): string {
    return `http://127.0.0.1:${port}`;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  }

  private request(method: string, params?: unknown): BrpJsonRpcRequest {
    const request: BrpJsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method };
    if (params !== undefined) request.params = params;
    return request;
  }
}

/**
 * Reject any decoded JSON integer that is not a safe JavaScript integer
 * (64-bit entity ids and component integers), naming the method and the
 * value path. Floats are untouched.
 */
function assertSafeIntegers(value: unknown, method: string, path: string): void {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new BrpPrecisionError(method, path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeIntegers(item, method, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertSafeIntegers(item, method, `${path}.${key}`);
    }
  }
}

/** Consume an error response body so the socket can be released. */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => {});
}
