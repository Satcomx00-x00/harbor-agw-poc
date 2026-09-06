/**
 * mcp-harbor — an MCP server over Harbor, with no credentials of its own.
 *
 * Transport is streamable HTTP in *stateless* mode: a fresh McpServer and
 * transport are built for every POST and thrown away with the response.
 *
 * That looks wasteful and is the important design decision here. The caller's
 * bearer token arrives on the HTTP request, and in stateless mode it can be
 * closed over by exactly the objects handling that one request. A stateful
 * server — one long-lived McpServer with sessions — would have to stash tokens
 * somewhere keyed by session id, and every bug in that bookkeeping is one user
 * reading another user's registry. The construction cost is a few
 * microseconds; the class of bug it removes is the only one that really
 * matters in front of a multi-tenant registry.
 *
 * Authentication is not performed here. agentgateway validates the JWT against
 * Keycloak and forwards it (`backendAuth: passthrough`). This server only
 * checks a token is present, and lets Harbor be the authority on whether it is
 * any good — Harbor has to make that decision regardless, so duplicating it
 * here would just be a second, staler opinion.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { HarborClient } from "./harbor.js";
import { registerTools } from "./tools.js";

const cfg = loadConfig();

/** Pull the bearer token out of the request, if there is one. */
function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() || undefined;
}

/**
 * JSON-RPC error body for a request that arrived without a token.
 *
 * 401 with `WWW-Authenticate` rather than a plain 400: an MCP client that
 * understands OAuth uses that header to discover where to authenticate, and
 * agentgateway publishes the matching protected-resource metadata.
 */
function unauthorized(res: Response) {
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer realm="mcp-harbor", error="invalid_request"')
    .json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "No bearer token on the request. This server acts only on the caller's " +
          "identity and has no credentials of its own. Reach it through " +
          "agentgateway, which validates the token and forwards it.",
      },
      id: null,
    });
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", harbor: cfg.harborUrl });
});

/**
 * Liveness is not readiness here: this server is ready as soon as it listens,
 * because it holds no connection to Harbor to keep warm. Harbor being down is
 * a per-call failure the model gets told about, not a reason to take the pod
 * out of rotation.
 */
app.get("/readyz", (_req, res) => res.json({ status: "ok" }));

app.post("/mcp", async (req: Request, res: Response) => {
  const token = bearer(req);
  if (!token && !cfg.allowAnonymous) return unauthorized(res);

  const server = new McpServer(
    { name: "mcp-harbor", version: "0.1.0" },
    {
      instructions:
        "Tools over a Harbor container registry. Every call runs as the user " +
        "whose OIDC token was forwarded with the request, so results are " +
        "already scoped to what that user may see. If a call returns 401 or " +
        "403, call harbor_whoami to find out which of the two is happening.",
    },
  );

  registerTools(server, new HarborClient(cfg, token));

  // Stateless: no session id, no server-initiated SSE stream. Both are what a
  // long-lived session would need, and neither is needed to answer one call.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Order matters: closing the transport also closes the server, so tearing
  // down on response end must not race the handler still writing to it.
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

/**
 * GET and DELETE on /mcp are the stateful half of the streamable HTTP
 * transport: resuming a server-initiated stream, and ending a session. Neither
 * exists in stateless mode, so answer 405 rather than let the SDK produce a
 * confusing session error.
 */
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
    `mcp-harbor listening on ${cfg.host}:${cfg.port} -> ${cfg.harborUrl}` +
      (cfg.allowAnonymous ? "  [ALLOW_ANONYMOUS is on — development only]" : ""),
  );
});
