/** JSON-RPC 2.0 request payload sent to the BRP HTTP endpoint. */
export interface BrpJsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response envelope returned by BRP. */
export interface BrpJsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
