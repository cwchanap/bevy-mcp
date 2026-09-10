/** Base class for every BRP transport error. */
export class BrpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The BRP endpoint answered with a non-2xx HTTP status. */
export class BrpHttpError extends BrpError {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`BRP endpoint returned HTTP ${status} ${statusText}`);
    this.status = status;
  }
}

/** The BRP endpoint answered with a JSON-RPC 2.0 error object. */
export class BrpJsonRpcError extends BrpError {
  readonly code: number;
  readonly data?: unknown;
  /** The raw BRP error message, before this wrapper adds context. */
  readonly brpMessage: string;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`BRP call '${method}' failed with JSON-RPC error ${code}: ${message}`);
    this.code = code;
    this.data = data;
    this.brpMessage = message;
  }
}

/** The response body was not valid JSON. */
export class BrpMalformedResponseError extends BrpError {
  constructor(method: string, options?: { cause?: unknown }) {
    super(`BRP call '${method}' returned a malformed JSON body`, options);
  }
}

/** The instant call did not complete within its timeout. */
export class BrpTimeoutError extends BrpError {
  constructor(method: string, timeoutMs: number) {
    super(`BRP call '${method}' timed out after ${timeoutMs}ms`);
  }
}

/** The caller aborted the request. */
export class BrpAbortError extends BrpError {
  constructor(method: string) {
    super(`BRP call '${method}' was aborted by the caller`);
  }
}

/** A decoded JSON integer would lose 64-bit precision (e.g. entity ids). */
export class BrpPrecisionError extends BrpError {
  /** The JSON path of the offending value, so reporters can name the location
   * without reproducing the already-corrupted float. */
  readonly path: string;

  constructor(method: string, path: string, value: number) {
    super(
      `BRP call '${method}' returned an unsafe integer at ${path}: ${value} would lose 64-bit precision`,
    );
    this.path = path;
  }
}
