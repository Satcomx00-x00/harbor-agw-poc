/**
 * Configuration, read once at start-up.
 *
 * Two files decide everything this server does: an OpenAPI document and an
 * allowlist. Point them at a different service and it becomes a different MCP
 * server, with no code change.
 */

export type UpstreamAuth = "oidc" | "none";

export interface Config {
  /** OpenAPI document: a path on disk or an http(s) URL. */
  spec: string;
  /** Allowlist file: a path on disk or an http(s) URL. */
  allowlist: string;

  /**
   * Base URL for upstream calls.
   *
   * Optional: the spec's own `servers[0].url` is used when this is unset. It
   * exists because a published document routinely advertises a public URL that
   * is not the one to dial from inside a cluster — and because `servers` is
   * allowed to be relative, or absent entirely.
   */
  baseUrl: string | undefined;

  /**
   * What credential, if any, this server sends upstream.
   *
   * `oidc`  forward the caller's validated token, so the upstream sees the
   *         human. This is the interesting case and the default.
   * `none`  send nothing. The upstream needs no credential — but callers still
   *         have to authenticate to agentgateway to get here at all.
   *
   * Note this is entirely separate from *inbound* authentication, which is not
   * optional and is not performed here. See README.
   */
  upstreamAuth: UpstreamAuth;

  /** MCP server name advertised to clients. Defaults to the spec's title. */
  serverName: string | undefined;

  /**
   * Prefix applied to every generated tool name, e.g. `harbor` gives
   * `harbor_list_projects`. Useful when a client mounts several of these.
   */
  toolPrefix: string | undefined;

  port: number;
  host: string;
  requestTimeoutMs: number;
  debug: boolean;

  /**
   * Accept requests with no bearer token.
   *
   * Off by default and it should stay off: agentgateway is what validates the
   * JWT, so a request arriving here without one has bypassed it. Only useful
   * when running the server directly during development, and meaningless when
   * upstreamAuth is `none` — the token is still what proves the *caller* is
   * allowed to use the tool.
   */
  allowAnonymous: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(): Config {
  const auth = (process.env.UPSTREAM_AUTH ?? "oidc").toLowerCase();
  if (auth !== "oidc" && auth !== "none") {
    throw new Error(`UPSTREAM_AUTH must be "oidc" or "none", got "${auth}"`);
  }

  return {
    spec: required("OPENAPI_SPEC"),
    allowlist: required("OPENAPI_ALLOWLIST"),
    baseUrl: process.env.UPSTREAM_BASE_URL?.replace(/\/+$/, ""),
    upstreamAuth: auth,
    serverName: process.env.MCP_SERVER_NAME,
    toolPrefix: process.env.MCP_TOOL_PREFIX,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 30000),
    debug: bool("DEBUG", false),
    allowAnonymous: bool("ALLOW_ANONYMOUS", false),
  };
}
