import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import { DEFAULT_BRP_PORT, BrpClient } from '../src/brp/client.js';
import {
  BrpAbortError,
  BrpError,
  BrpHttpError,
  BrpJsonRpcError,
  BrpMalformedResponseError,
  BrpPrecisionError,
  BrpTimeoutError,
} from '../src/brp/errors.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface TestServer {
  server: http.Server;
  port: number;
  /** Raw request bodies received, in order — used to count requests (no retry). */
  requests: string[];
  /** Remote address of the last request — proves the client dialed 127.0.0.1. */
  remoteAddress: string | undefined;
  close(): Promise<void>;
}

function startServer(handler: Handler): Promise<TestServer> {
  const requests: string[] = [];
  const state: TestServer = {
    server: undefined as unknown as http.Server,
    port: 0,
    requests,
    remoteAddress: undefined,
    close: () =>
      new Promise((resolve, reject) => {
        state.server.closeAllConnections();
        state.server.close((err?: Error | null) => (err ? reject(err) : resolve()));
      }),
  };
  const server = http.createServer((req, res) => {
    state.remoteAddress = req.socket.remoteAddress;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push(body);
      res.on('error', () => {});
      handler(req, res, body);
    });
  });
  state.server = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as net.AddressInfo).port;
      resolve(state);
    });
  });
}

/** A JSON-RPC 2.0 success handler echoing the request id. */
function jsonRpcResult(result: unknown): Handler {
  return (_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result }));
  };
}

/** An ephemeral port that nothing is listening on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

test('DEFAULT_BRP_PORT is 15702', () => {
  assert.equal(DEFAULT_BRP_PORT, 15702);
});

test('call() posts JSON-RPC 2.0 to 127.0.0.1:<port> exactly once and resolves the result', async () => {
  const server = await startServer(jsonRpcResult({ entity_id: 42 }));
  const client = new BrpClient();
  const params = { component_type: 'bevy_transform::components::transform::Transform' };

  const result = await client.call('world.spawn_entity', params, { port: server.port });

  assert.deepEqual(result, { entity_id: 42 });
  assert.equal(server.remoteAddress, '127.0.0.1');
  assert.equal(server.requests.length, 1);
  const sent = JSON.parse(server.requests[0]);
  assert.equal(sent.jsonrpc, '2.0');
  assert.equal(typeof sent.id, 'number');
  assert.equal(sent.method, 'world.spawn_entity');
  assert.deepEqual(sent.params, params);
  await server.close();
});

test('call() request ids are numeric and monotonically increasing', async () => {
  const server = await startServer(jsonRpcResult(null));
  const client = new BrpClient();

  await client.call('rpc.ping', undefined, { port: server.port });
  await client.call('rpc.ping', undefined, { port: server.port });

  assert.equal(server.requests.length, 2);
  const first = JSON.parse(server.requests[0]).id;
  const second = JSON.parse(server.requests[1]).id;
  assert.equal(typeof first, 'number');
  assert.equal(typeof second, 'number');
  assert.ok(second > first);
  await server.close();
});

test('call() rejects with BrpJsonRpcError on a JSON-RPC error object', async () => {
  const server = await startServer((_req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: JSON.parse(body).id,
        error: { code: -32602, message: 'Invalid params', data: { detail: 'missing key' } },
      }),
    );
  });

  await assert.rejects(
    new BrpClient().call('world.get_components', {}, { port: server.port }),
    (err: unknown) => {
      assert.ok(err instanceof BrpJsonRpcError);
      assert.equal(err.code, -32602);
      assert.match(err.message, /Invalid params/);
      assert.deepEqual(err.data, { detail: 'missing key' });
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
  await server.close();
});

test('call() rejects with BrpMalformedResponseError on malformed JSON', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not-json{{{');
  });

  await assert.rejects(
    new BrpClient().call('rpc.discover', undefined, { port: server.port }),
    BrpMalformedResponseError,
  );
  await server.close();
});

for (const [label, body] of [
  ['null', 'null'],
  ['a bare string', '"hello"'],
  ['an array', '[1]'],
  ['an object without result/error members', '{}'],
] as const) {
  test(`call() rejects with a typed error when the body is ${label}`, async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });

    await assert.rejects(
      new BrpClient().call('world.get_components', {}, { port: server.port }),
      (err: unknown) => {
        assert.ok(err instanceof BrpMalformedResponseError);
        assert.match(err.message, /world\.get_components/);
        return true;
      },
    );
    await server.close();
  });
}

test('call() timeout still fires when the body stalls after the headers', async () => {
  const server = await startServer((_req, res) => {
    // Headers go out immediately; the body never arrives.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
  });

  await assert.rejects(
    new BrpClient().call('world.spawn_entity', {}, { port: server.port, timeoutMs: 100 }),
    BrpTimeoutError,
  );
  await server.close();
});

test('call() rejects with BrpHttpError on HTTP >= 400 without retrying', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });

  await assert.rejects(
    new BrpClient().call('world.spawn_entity', {}, { port: server.port }),
    (err: unknown) => {
      assert.ok(err instanceof BrpHttpError);
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.equal(server.requests.length, 1);
  await server.close();
});

test('call() rejects when the connection is refused', async () => {
  const port = await freePort();
  await assert.rejects(
    new BrpClient().call('rpc.ping', undefined, { port }),
    BrpError,
  );
});

test('call() rejects with BrpAbortError when the caller aborts mid-flight', async () => {
  const server = await startServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 500);
  });
  const controller = new AbortController();
  const pending = new BrpClient().call('world.spawn_entity', {}, {
    port: server.port,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, BrpAbortError);
  assert.equal(server.requests.length, 1);
  await server.close();
});

test('call() rejects with BrpTimeoutError when the timeout elapses, without retrying', async () => {
  const server = await startServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 400);
  });

  await assert.rejects(
    new BrpClient().call('world.spawn_entity', {}, { port: server.port, timeoutMs: 50 }),
    BrpTimeoutError,
  );
  assert.equal(server.requests.length, 1);
  await server.close();
});

test('call() rejects with BrpPrecisionError naming the path for unsafe integers', async () => {
  const UNSAFE = 2 ** 63; // serializes as a 64-bit integer, unsafe in JS
  const server = await startServer(
    jsonRpcResult({ world: { entities: [UNSAFE], scale: 2.5, count: 2 ** 40 } }),
  );

  await assert.rejects(
    new BrpClient().call('world.get_components', {}, { port: server.port }),
    (err: unknown) => {
      assert.ok(err instanceof BrpPrecisionError);
      assert.match(err.message, /world\.get_components/);
      assert.match(err.message, /result\.world\.entities\[0\]/);
      return true;
    },
  );
  await server.close();
});

test('call() accepts floats and safe integers', async () => {
  const server = await startServer(jsonRpcResult({ scale: 2.5, count: 2 ** 40 }));
  const result = await new BrpClient().call<Record<string, number>>('world.get_components', {}, {
    port: server.port,
  });
  assert.deepEqual(result, { scale: 2.5, count: 2 ** 40 });
  await server.close();
});

test('discover() is an instant rpc.discover call with no params', async () => {
  const catalog = { methods: [{ identifier: 'world.spawn_entity' }] };
  const server = await startServer(jsonRpcResult(catalog));

  const result = await new BrpClient().discover(server.port);

  assert.deepEqual(result, catalog);
  const sent = JSON.parse(server.requests[0]);
  assert.equal(sent.method, 'rpc.discover');
  assert.equal(sent.params, undefined);
  await server.close();
});

test('stream() resolves at headers before the body arrives, with no request timeout', async () => {
  let chunkWritten = false;
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => {
      chunkWritten = true;
      res.write('data: {"jsonrpc":"2.0","result":{}}\n\n');
    }, 100);
  });

  const response = await new BrpClient().stream('world.get_components+watch', {}, {
    port: server.port,
  });

  // Headers are established (the promise resolved) while the body is still pending.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(chunkWritten, false);

  const reader = response.body!.getReader();
  const chunk = await reader.read();
  assert.equal(chunkWritten, true);
  assert.match(new TextDecoder().decode(chunk.value), /^data: /);
  await reader.cancel();
  await server.close();
});

test('stream() forwards the caller abort signal to the response body', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const controller = new AbortController();
  const response = await new BrpClient().stream('world.list_components+watch', {}, {
    port: server.port,
    signal: controller.signal,
  });

  const reader = response.body!.getReader();
  const pending = reader.read();
  controller.abort();

  await assert.rejects(pending);
  await reader.cancel().catch(() => {});
  await server.close();
});

test('stream() rejects with BrpHttpError on HTTP >= 400', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('unavailable');
  });

  await assert.rejects(
    new BrpClient().stream('world.get_components+watch', {}, { port: server.port }),
    (err: unknown) => {
      assert.ok(err instanceof BrpHttpError);
      assert.equal(err.status, 503);
      return true;
    },
  );
  await server.close();
});
