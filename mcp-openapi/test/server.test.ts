/**
 * Component smoke test.
 *
 * Starts a stub upstream, spawns the real server against it, and drives it over
 * HTTP exactly as agentgateway would. Nothing is mocked inside the server, so
 * this is what catches the things unit tests structurally cannot: the boot
 * sequence, the transport, and — the reason it exists — what actually leaves
 * the process on the wire under each auth mode.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openapi3 } from "./fixtures.js";

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** Records what the server sent, which is the only thing worth asserting. */
class StubUpstream {
  readonly received: Received[] = [];
  #server: Server | undefined;
  #port = 0;

  get url(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req: IncomingMessage, res) => {
      this.received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        headers: req.headers,
      });
      if ((req.url ?? "").startsWith("/v1/deny")) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"message":"nope"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, saw: req.url }));
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, "127.0.0.1", () => {
        const address = this.#server?.address();
        if (address !== null && typeof address === "object") this.#port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

interface Started {
  child: ChildProcess;
  base: string;
  stderr: string[];
}

async function startServer(env: Record<string, string>, port: number): Promise<Started> {
  const entry = join(import.meta.dirname, "..", "src", "index.js");
  const stderr: string[] = [];
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const base = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${String(child.exitCode)}:\n${stderr.join("")}`);
    }
    try {
      const res = await fetch(`${base}/readyz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready:\n${stderr.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, base, stderr };
}

const MCP_HEADERS = {
  "content-type": "application/json",
  // Both are required by the streamable HTTP transport; sending only
  // application/json gets a 406 that reads like a server bug.
  accept: "application/json, text/event-stream",
};

async function rpc(
  base: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: token === undefined ? MCP_HEADERS : { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (text === "") return { status: res.status, json: {} };
  return { status: res.status, json: JSON.parse(text) as Record<string, any> };
}

const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
});

describe("mcp-openapi server", () => {
  const upstream = new StubUpstream();
  let oidc: Started;
  let none: Started;
  let specPath = "";
  let allowlistPath = "";

  before(async () => {
    await upstream.start();

    const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-test-"));
    specPath = join(dir, "openapi.json");
    allowlistPath = join(dir, "allowlist.txt");
    await writeFile(specPath, JSON.stringify(openapi3), "utf8");
    await writeFile(
      allowlistPath,
      ["GET /widgets", "GET /widgets/{id}", "GET /health", "# POST /widgets is deliberately absent"].join("\n"),
      "utf8",
    );

    const shared = {
      OPENAPI_SPEC: specPath,
      OPENAPI_ALLOWLIST: allowlistPath,
      UPSTREAM_BASE_URL: upstream.url,
    };
    oidc = await startServer({ ...shared, UPSTREAM_AUTH: "oidc" }, 18_181);
    none = await startServer({ ...shared, UPSTREAM_AUTH: "none" }, 18_182);
  });

  after(async () => {
    oidc.child.kill();
    none.child.kill();
    await upstream.stop();
  });

  it("keeps the document's base path when overriding the origin", () => {
    assert.ok(
      oidc.stderr.join("").includes("/v1"),
      "the document declares servers[0].url with a /v1 path",
    );
  });

  it("refuses a request with no bearer token", async () => {
    const { status, json } = await rpc(oidc.base, initialize(1));
    assert.equal(status, 401);
    assert.match(String(json.error?.message), /agentgateway/);
  });

  it("refuses a request with no token even when UPSTREAM_AUTH=none", async () => {
    // `none` describes what goes upstream, never who may call.
    const { status } = await rpc(none.base, initialize(1));
    assert.equal(status, 401);
  });

  it("completes an MCP handshake", async () => {
    const { status, json } = await rpc(oidc.base, initialize(1), "tok");
    assert.equal(status, 200);
    assert.equal(json.result?.serverInfo?.name, "Widgets");
  });

  it("lists exactly the allowlisted operations", async () => {
    const { json } = await rpc(oidc.base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "tok");
    const names = (json.result?.tools as { name: string }[]).map((t) => t.name).sort();
    assert.deepEqual(names, ["getWidget", "get_health", "listWidgets"]);
    assert.ok(!names.includes("createWidget"), "POST /widgets is in the document but not listed");
  });

  it("serves the same list over GET /tools, for debugging without a client", async () => {
    const res = await fetch(`${oidc.base}/tools`);
    const tools = (await res.json()) as { name: string }[];
    assert.equal(tools.length, 3);
  });

  it("forwards the caller's token upstream under UPSTREAM_AUTH=oidc", async () => {
    const before = upstream.received.length;
    await rpc(
      oidc.base,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listWidgets", arguments: {} } },
      "caller-token",
    );
    const sent = upstream.received.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.authorization, "Bearer caller-token");
  });

  it("sends no credential upstream under UPSTREAM_AUTH=none", async () => {
    // The property that makes `none` meaningful: the caller was authenticated
    // to get here, and their credential still does not leave the process.
    const before = upstream.received.length;
    await rpc(
      none.base,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listWidgets", arguments: {} } },
      "caller-token",
    );
    const sent = upstream.received.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.authorization, undefined);
  });

  it("passes query arguments through to the upstream URL", async () => {
    const before = upstream.received.length;
    await rpc(
      oidc.base,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "listWidgets", arguments: { page: 3, tag: ["a", "b"] } },
      },
      "tok",
    );
    const sent = upstream.received.slice(before)[0];
    assert.match(sent?.url ?? "", /page=3/);
    assert.match(sent?.url ?? "", /tag=a&tag=b/);
  });

  it("rejects a call to an operation that is not allowlisted", async () => {
    const { json } = await rpc(
      oidc.base,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "createWidget", arguments: {} } },
      "tok",
    );
    assert.equal(json.result?.isError, true);
    assert.match(String(json.result?.content?.[0]?.text), /no such tool/);
  });

  it("rejects invalid arguments before making a request", async () => {
    const before = upstream.received.length;
    const { json } = await rpc(
      oidc.base,
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "getWidget", arguments: {} } },
      "tok",
    );
    assert.equal(json.result?.isError, true);
    assert.match(String(json.result?.content?.[0]?.text), /invalid arguments/);
    assert.equal(upstream.received.length, before, "nothing should reach the upstream");
  });

  it("answers 405 on GET /mcp, which is the stateful half of the transport", async () => {
    const res = await fetch(`${oidc.base}/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  it("reports its configuration on /healthz", async () => {
    const res = await fetch(`${oidc.base}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.upstreamAuth, "oidc");
    assert.equal(body.tools, 3);
  });
});

describe("mcp-openapi boot failures", () => {
  it("exits rather than serving fewer tools than the allowlist asked for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-openapi-bad-"));
    const spec = join(dir, "openapi.json");
    const allow = join(dir, "allowlist.txt");
    await writeFile(spec, JSON.stringify(openapi3), "utf8");
    await writeFile(allow, "GET /widgets\nGET /typo", "utf8");

    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.js")], {
      env: {
        ...process.env,
        PORT: "18183",
        HOST: "127.0.0.1",
        OPENAPI_SPEC: spec,
        OPENAPI_ALLOWLIST: allow,
        UPSTREAM_BASE_URL: "http://127.0.0.1:1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /matched no operation/);
    assert.match(stderr, /GET \/typo/);
  });
});
