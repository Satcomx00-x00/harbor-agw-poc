/**
 * mcp-openapi — any OpenAPI document, exposed as MCP tools, restricted to an
 * explicit allowlist.
 *
 * Two authentications, and confusing them is the mistake worth naming:
 *
 *   inbound   Always required. agentgateway validates the caller's Keycloak
 *             token before anything reaches this process. Not performed here.
 *   outbound  UPSTREAM_AUTH=oidc forwards the caller's token upstream;
 *             UPSTREAM_AUTH=none sends nothing. `none` says the *upstream*
 *             needs no credential — it never means the caller needs none.
 *
 * The SDK's low-level Server is used rather than McpServer because tool
 * schemas come straight from the OpenAPI document. McpServer takes Zod and
 * converts it to JSON Schema; here the JSON Schema already exists, and round
 * -tripping it through Zod could only lose formats, enums and nested
 * constraints.
 */

import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";

// ajv 8 and ajv-formats are CommonJS, and their .d.ts files use `export
// default` even though the emitted files set `module.exports = Ajv`. Under
// module: nodenext TypeScript therefore resolves `import Ajv from "ajv"` to the
// module namespace, which is not constructable, and the build fails with
// "This expression is not constructable" — a type error about a package that
// works perfectly at runtime.
//
// createRequire sidesteps the mismatch by loading them the way they were built,
// while `typeof import(...).default` keeps the real types. Verified against
// both packages: require() returns the callable itself, not a { default } box.
const require = createRequire(import.meta.url);
const Ajv = require("ajv") as unknown as typeof import("ajv").default;
const addFormats = require("ajv-formats") as unknown as typeof import("ajv-formats").default;

import { loadConfig } from "./config.js";
import { applyAllowlist, parseAllowlist } from "./allowlist.js";
import { UpstreamClient, UpstreamError } from "./client.js";
import { buildOperation, inputSchemaFor, loadSpec, loadText, type Operation } from "./spec.js";

const cfg = loadConfig();

// ─────────────────────────────────────────────────────────────────────────────
// Start-up: spec + allowlist -> the fixed set of tools this process serves
// ─────────────────────────────────────────────────────────────────────────────

console.error(`[boot] spec      ${cfg.spec}`);
console.error(`[boot] allowlist ${cfg.allowlist}`);

const spec = await loadSpec(cfg.spec, cfg.requestTimeoutMs);
const rules = parseAllowlist(await loadText(cfg.allowlist, cfg.requestTimeoutMs));
const selection = applyAllowlist(rules, spec.candidates);

// A rule that matches nothing is almost always a typo, and the damage is a
// tool that silently does not exist. Refusing to start is louder than a log
// line nobody reads.
if (selection.deadRules.length) {
  console.error("\n[boot] allowlist rules that matched no operation in the spec:");
  for (const r of selection.deadRules) {
    console.error(`  line ${r.line}: ${r.raw}`);
  }
  console.error(
    "\nEvery include rule must match at least one operation. Check the method, " +
      "and remember templated segments are matched literally: /users/{id}, not /users/*.\n",
  );
  process.exit(1);
}

if (!selection.selected.length) {
  console.error("[boot] the allowlist selected no operations — nothing to serve");
  process.exit(1);
}

// Base URL resolution.
//
// UPSTREAM_BASE_URL overrides the *origin*; the document keeps its base path.
// That split is not fussiness — it is the shape of almost every real spec:
//
//   Harbor    host: localhost, basePath: /api/v2.0
//   OpenAPI 3 servers: [{ url: "https://api.example.com/v1" }]
//
// The host in a published document is routinely a placeholder while the path
// under it is authoritative. Overriding the whole URL therefore silently drops
// "/api/v2.0", every request lands on the web portal, and the tool returns a
// page of HTML instead of JSON — which reads like an auth problem and is not.
//
// An override that carries its own path is taken verbatim: the operator was
// explicit and should win.
function resolveBaseUrl(): string {
  const declared = spec.serverUrl?.replace(/\/+$/, "") ?? "";
  const override = cfg.baseUrl?.replace(/\/+$/, "") ?? "";

  if (!override) return declared;
  if (!declared) return override;

  const declaredPath = /^https?:\/\//i.test(declared)
    ? new URL(declared).pathname.replace(/\/+$/, "")
    : declared;

  let overridePath = "";
  try {
    overridePath = new URL(override).pathname.replace(/\/+$/, "");
  } catch {
    return override;
  }

  if (overridePath) return override;                 // operator gave a path
  if (!declaredPath || declaredPath === "") return override;

  console.error(
    `[boot] base URL: origin from UPSTREAM_BASE_URL + path "${declaredPath}" from the spec`,
  );
  return override + declaredPath;
}

const baseUrl = resolveBaseUrl();
if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
  console.error(
    `[boot] no usable upstream base URL.\n` +
      `  spec servers[0]: ${spec.serverUrl ?? "(none)"}\n` +
      `  UPSTREAM_BASE_URL: ${cfg.baseUrl ?? "(unset)"}\n` +
      `Set UPSTREAM_BASE_URL to an absolute http(s) URL. A spec's servers entry ` +
      `is often relative, or points at a host only reachable from elsewhere.`,
  );
  process.exit(1);
}

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: true });
addFormats(ajv);

interface Tool {
  operation: Operation;
  schema: Record<string, unknown>;
  validate: ValidateFunction;
}

const tools = new Map<string, Tool>();

for (const c of selection.selected) {
  const raw = spec.operations.get(`${c.method} ${c.path}`);
  if (!raw) continue;

  const operation = buildOperation(raw, cfg.toolPrefix);
  if (tools.has(operation.toolName)) {
    // Two operations collapsing to one tool name would make one unreachable,
    // and which one wins would depend on map ordering.
    console.error(
      `[boot] duplicate tool name "${operation.toolName}" ` +
        `(${operation.method} ${operation.path}). Set MCP_TOOL_PREFIX, or give ` +
        `the operations distinct operationIds in the spec.`,
    );
    process.exit(1);
  }

  const schema = inputSchemaFor(operation);
  tools.set(operation.toolName, {
    operation,
    schema,
    validate: ajv.compile(schema),
  });
}

console.error(
  `[boot] ${spec.title} ${spec.version} → ${tools.size} tool(s), upstream ${baseUrl}, ` +
    `outbound auth=${cfg.upstreamAuth}`,
);
for (const t of tools.values()) {
  console.error(`         ${t.operation.method.padEnd(6)} ${t.operation.path}  →  ${t.operation.toolName}`);
}
for (const e of selection.excluded) {
  console.error(`  excluded ${e.candidate.method} ${e.candidate.path} (line ${e.rule.line}: ${e.rule.raw})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() || undefined;
}

function describe(op: Operation): string {
  const parts = [op.summary, op.description].filter(Boolean) as string[];
  const head = parts.length ? parts.join("\n\n") : `${op.method} ${op.path}`;
  return `${head}\n\nCalls ${op.method} ${op.path} on the upstream API.`;
}

function buildServer(token: string | undefined): Server {
  const server = new Server(
    { name: cfg.serverName ?? spec.title, version: spec.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((t) => ({
      name: t.operation.toolName,
      description: describe(t.operation),
      inputSchema: t.schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.get(req.params.name);
    // Only allowlisted operations exist as tools, so an unknown name here is
    // either a stale client or an attempt to reach something not exposed.
    // Both get the same answer.
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `no such tool: ${req.params.name}` }],
      };
    }

    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!tool.validate(args)) {
      const errs = (tool.validate.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
        .join("; ");
      return {
        isError: true,
        content: [{ type: "text", text: `invalid arguments: ${errs}` }],
      };
    }

    try {
      const client = new UpstreamClient(cfg, baseUrl, token);
      const result = await client.call(tool.operation, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const lines: string[] = [];
      if (err instanceof UpstreamError) {
        lines.push(err.message);
        if (err.hint) lines.push(`\nHint: ${err.hint}`);
      } else {
        lines.push(err instanceof Error ? err.message : String(err));
      }
      // isError rather than a thrown exception: "you may not see that project"
      // is an answer the model should get, not a broken tool.
      return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
    }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    spec: { title: spec.title, version: spec.version },
    upstream: baseUrl,
    upstreamAuth: cfg.upstreamAuth,
    tools: tools.size,
  });
});

app.get("/readyz", (_req, res) => res.json({ status: "ok" }));

/** The tools this server exposes, for debugging an allowlist without an MCP client. */
app.get("/tools", (_req, res) => {
  res.json(
    [...tools.values()].map((t) => ({
      name: t.operation.toolName,
      method: t.operation.method,
      path: t.operation.path,
    })),
  );
});

app.post("/mcp", async (req: Request, res: Response) => {
  const token = bearer(req);
  if (!token && !cfg.allowAnonymous) {
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
    `[boot] listening on ${cfg.host}:${cfg.port}` +
      (cfg.allowAnonymous ? "  [ALLOW_ANONYMOUS is on — development only]" : ""),
  );
});
