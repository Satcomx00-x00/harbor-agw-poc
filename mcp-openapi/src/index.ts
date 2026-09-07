/**
 * mcp-openapi — any OpenAPI document, exposed as MCP tools, on an allowlist.
 *
 * Two authentications, and confusing them is the mistake worth naming:
 *
 *   inbound   Always required. agentgateway validates the caller's Keycloak
 *             token before anything reaches this process. Not performed here.
 *   outbound  An UpstreamAuth strategy (auth.ts) decides what is forwarded.
 *             `none` says the *upstream* needs no credential — it never means
 *             the caller needs none.
 *
 * This file is wiring and HTTP. Everything with a decision in it lives in a
 * module that can be tested without a socket.
 */

import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createUpstreamAuth } from "./auth.js";
import { BaseUrlError, resolveBaseUrl } from "./base-url.js";
import { UpstreamClient, UpstreamError, type ClientOptions } from "./client.js";
import { loadConfig } from "./config.js";
import { buildRegistry, RegistryError, type Registry } from "./registry.js";
import { loadSpec, loadText, type Operation } from "./spec.js";

const cfg = loadConfig();

console.error(`[boot] document  ${cfg.spec}`);
console.error(`[boot] allowlist ${cfg.allowlist}`);

const spec = await loadSpec(cfg.spec, cfg.requestTimeoutMs);

let registry: Registry;
let clientOptions: ClientOptions;
try {
  registry = buildRegistry(
    spec,
    await loadText(cfg.allowlist, cfg.requestTimeoutMs),
    cfg.toolPrefix,
  );

  const base = resolveBaseUrl({ declared: spec.declaredBaseUrl, override: cfg.baseUrl });
  console.error(`[boot] base URL: ${base.url}  (${base.reason})`);

  clientOptions = {
    baseUrl: base.url,
    auth: createUpstreamAuth(cfg.upstreamAuth),
    timeoutMs: cfg.requestTimeoutMs,
    debug: cfg.debug,
  };
} catch (err) {
  // Configuration errors, not runtime faults: a stack trace helps nobody, and
  // the message already says what to change.
  if (err instanceof RegistryError || err instanceof BaseUrlError) {
    console.error(`\n[boot] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

console.error(
  `[boot] ${spec.title} ${spec.version} (${spec.adapter.dialect}) → ` +
    `${String(registry.tools.size)} tool(s), ${clientOptions.auth.describe()}`,
);
for (const tool of registry.tools.values()) {
  console.error(
    `         ${tool.operation.method.padEnd(6)} ${tool.operation.path}` +
      `  →  ${tool.operation.toolName}`,
  );
}
for (const item of registry.excluded) {
  console.error(
    `  excluded ${item.method} ${item.path} ` +
      `(line ${String(item.rule.line)}: ${item.rule.raw})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

function describe(op: Operation): string {
  const parts = [op.summary, op.description].filter((s): s is string => s !== undefined);
  const head = parts.length > 0 ? parts.join("\n\n") : `${op.method} ${op.path}`;
  return `${head}\n\nCalls ${op.method} ${op.path} on the upstream API.`;
}

function textResult(text: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text }] };
}

/*
 * `Server` is deprecated in favour of `McpServer`, and this is the "advanced
 * use case" that notice carves out.
 *
 * McpServer's `inputSchema` is typed `ZodRawShapeCompat | AnySchema`, and
 * AnySchema is `z3.ZodTypeAny | z4.$ZodType` — Zod only. The schemas here come
 * from an OpenAPI document and are already JSON Schema, which is also what MCP
 * puts on the wire. Going through McpServer would mean JSON Schema → Zod →
 * JSON Schema, and the middle step cannot represent everything the ends can:
 * formats, nested constraints, anything the document expresses that Zod has no
 * constructor for. The low-level Server takes them unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
function buildServer(token: string | undefined): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: cfg.serverName ?? spec.title, version: spec.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...registry.tools.values()].map((tool) => ({
      name: tool.operation.toolName,
      description: describe(tool.operation),
      inputSchema: tool.schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = registry.tools.get(req.params.name);
    // Only allowlisted operations exist as tools, so an unknown name is either
    // a stale client or an attempt to reach something not exposed. Both get the
    // same answer.
    if (!tool) return textResult(`no such tool: ${req.params.name}`, true);

    const args: Record<string, unknown> = req.params.arguments ?? {};
    if (!tool.validate(args)) {
      const errors = (tool.validate.errors ?? [])
        .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? ""}`)
        .join("; ");
      return textResult(`invalid arguments: ${errors}`, true);
    }

    try {
      const result = await new UpstreamClient(clientOptions, token).call(tool.operation, args);
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      const lines: string[] = [];
      if (err instanceof UpstreamError) {
        lines.push(err.message);
        if (err.hint !== undefined) lines.push(`\nHint: ${err.hint}`);
      } else {
        lines.push(err instanceof Error ? err.message : String(err));
      }
      // isError rather than a thrown exception: "you may not see that project"
      // is an answer the model should get, not a broken tool.
      return textResult(lines.join("\n"), true);
    }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    document: { title: spec.title, version: spec.version, dialect: spec.adapter.dialect },
    upstream: clientOptions.baseUrl,
    upstreamAuth: clientOptions.auth.mode,
    tools: registry.tools.size,
  });
});

app.get("/readyz", (_req, res) => {
  res.json({ status: "ok" });
});

/** What the allowlist selected, for debugging without an MCP client. */
app.get("/tools", (_req, res) => {
  res.json(
    [...registry.tools.values()].map((tool) => ({
      name: tool.operation.toolName,
      method: tool.operation.method,
      path: tool.operation.path,
    })),
  );
});

app.post("/mcp", async (req: Request, res: Response) => {
  const token = bearer(req);
  if (token === undefined && !cfg.allowAnonymous) {
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="mcp-openapi", error="invalid_request"')
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "No bearer token. Reach this server through agentgateway, which " +
            "validates the token. This is required even when UPSTREAM_AUTH=none: " +
            "that setting governs what is sent upstream, not who may call.",
        },
        id: null,
      });
    return;
  }

  const server = buildServer(token);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      });
    }
  }
});

for (const method of ["get", "delete"] as const) {
  app[method]("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server is stateless; use POST /mcp." },
      id: null,
    });
  });
}

app.listen(cfg.port, cfg.host, () => {
  console.error(
    `[boot] listening on ${cfg.host}:${String(cfg.port)}` +
      (cfg.allowAnonymous ? "  [ALLOW_ANONYMOUS is on — development only]" : ""),
  );
});
