/**
 * UpstreamClient.call against a real socket.
 *
 * planRequest is covered in client.test.ts without any I/O; this covers what
 * only happens once a response comes back — status mapping, content-type
 * handling, timeouts — which is where a client quietly turns a useful error
 * into a useless one.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createUpstreamAuth } from "../src/auth.js";
import { UpstreamClient, UpstreamError, type ClientOptions } from "../src/client.js";
import { asDocument } from "../src/openapi.js";
import { buildOperation, indexDocument, type Operation } from "../src/spec.js";
import { openapi3 } from "./fixtures.js";

const spec = indexDocument(asDocument(openapi3));

function operation(key: string): Operation {
  const raw = spec.operations.get(key);
  assert.ok(raw, `no operation ${key}`);
  return buildOperation(raw, spec.adapter);
}

/** Replies however the current test needs it to. */
let respond: (url: string) => { status: number; type: string; body: string; delayMs?: number };

let server: Server;
let port = 0;

const options = (overrides: Partial<ClientOptions> = {}): ClientOptions => ({
  baseUrl: `http://127.0.0.1:${String(port)}/v1`,
  auth: createUpstreamAuth("oidc"),
  timeoutMs: 2000,
  ...overrides,
});

describe("UpstreamClient.call", () => {
  before(async () => {
    server = createServer((req, res) => {
      const reply = respond(req.url ?? "");
      const send = () => {
        res.writeHead(reply.status, { "content-type": reply.type });
        res.end(reply.body);
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address !== null && typeof address === "object") port = address.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("parses a JSON response", async () => {
    respond = () => ({ status: 200, type: "application/json", body: '{"ok":true}' });
    const result = await new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {});
    assert.deepEqual(result, { ok: true });
  });

  it("returns text when the response is not JSON", async () => {
    respond = () => ({ status: 200, type: "text/plain", body: "hello" });
    const result = await new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {});
    assert.equal(result, "hello");
  });

  it("returns the text when the content type lies about being JSON", async () => {
    // Failing here would turn a cosmetic server bug into an unusable tool.
    respond = () => ({ status: 200, type: "application/json", body: "not json at all" });
    const result = await new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {});
    assert.equal(result, "not json at all");
  });

  it("reports an empty body rather than failing to parse it", async () => {
    respond = () => ({ status: 204, type: "application/json", body: "" });
    const result = await new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {});
    assert.deepEqual(result, { status: 204, body: null });
  });

  it("raises UpstreamError carrying the status and the body", async () => {
    respond = () => ({ status: 403, type: "application/json", body: '{"message":"nope"}' });
    const err = await rejects(() =>
      new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {}),
    );
    assert.ok(err instanceof UpstreamError);
    assert.equal(err.status, 403);
    assert.match(err.message, /nope/);
  });

  it("explains a 401 in terms of the two auth modes", async () => {
    // The hint is the difference between "the token was rejected" and an hour
    // spent looking in the wrong place.
    respond = () => ({ status: 401, type: "application/json", body: "{}" });
    const err = await rejects(() =>
      new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {}),
    );
    assert.ok(err instanceof UpstreamError);
    assert.match(err.hint ?? "", /UPSTREAM_AUTH=none/);
  });

  it("points a 404 at the base URL, the usual cause", async () => {
    respond = () => ({ status: 404, type: "application/json", body: "{}" });
    const err = await rejects(() =>
      new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {}),
    );
    assert.ok(err instanceof UpstreamError);
    assert.match(err.hint ?? "", /UPSTREAM_BASE_URL/);
  });

  it("truncates a very large error body", async () => {
    respond = () => ({ status: 500, type: "text/plain", body: "x".repeat(5000) });
    const err = await rejects(() =>
      new UpstreamClient(options(), "tok").call(operation("GET /widgets"), {}),
    );
    assert.ok(err.message.length < 1200, "an error message is not a place for 5 kB");
  });

  it("times out with a message naming the budget", async () => {
    // AbortError alone says nothing about how long was allowed.
    respond = () => ({ status: 200, type: "application/json", body: "{}", delayMs: 500 });
    const err = await rejects(() =>
      new UpstreamClient(options({ timeoutMs: 50 }), "tok").call(operation("GET /widgets"), {}),
    );
    assert.match(err.message, /timed out after 50ms/);
    assert.ok(err.cause instanceof Error, "the abort should stay attached as the cause");
  });

  it("surfaces a connection failure rather than swallowing it", async () => {
    const dead = options({ baseUrl: "http://127.0.0.1:1/v1" });
    const err = await rejects(() =>
      new UpstreamClient(dead, "tok").call(operation("GET /widgets"), {}),
    );
    assert.ok(err instanceof Error);
    assert.ok(!(err instanceof UpstreamError), "no HTTP response means no HTTP status");
  });

  it("refuses a bad argument before opening a connection", async () => {
    // `call` is async, so planRequest's throw arrives as a rejection rather
    // than a synchronous exception.
    respond = () => ({ status: 200, type: "application/json", body: "{}" });
    const err = await rejects(() =>
      new UpstreamClient(options(), "tok").call(operation("GET /widgets/{id}"), {}),
    );
    assert.match(err.message, /missing required path parameter/);
  });
});

/** Await a rejection and hand back the error. */
async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  return assert.fail("expected the call to reject");
}
