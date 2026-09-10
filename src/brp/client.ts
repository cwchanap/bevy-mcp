import {
  BrpAbortError,
  BrpError,
  BrpHttpError,
  BrpJsonRpcError,
  BrpMalformedResponseError,
  BrpTimeoutError,
} from './errors.js';
import { assertSafeIntegers } from './safe-json.js';
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

/** A consumed instant-call response: status line plus the full body text. */
interface PostedResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text: string;
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
      throw new BrpHttpError(response.status, response.statusText);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.text);
    } catch (cause) {
      throw new BrpMalformedResponseError(method, { cause });
    }
    assertSafeIntegers(decoded, method, 'result');
    // Typed rejection for bodies that parse but are not JSON-RPC envelopes:
    // null/primitives/arrays, or objects without a result or error member.
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      (!('result' in decoded) && !('error' in decoded))
    ) {
      throw new BrpMalformedResponseError(method);
    }
    const envelope = decoded as BrpJsonRpcResponse;
    if (envelope.error !== undefined) {
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

  /**
   * POST one instant call and consume the body inside the timeout/abort
   * window: the abort guard stays armed until the body is fully read, so a
   * server that stalls after the headers still hits the deadline.
   */
  private async post(
    method: string,
    params: unknown,
    options: BrpCallOptions,
    timeoutMs: number,
  ): Promise<PostedResponse> {
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
      const response = await fetch(this.endpointUrl(options.port), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.request(method, params)),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, statusText: response.statusText, ok: response.ok, text };
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

/** Consume an error response body so the socket can be released. */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => {});
}
