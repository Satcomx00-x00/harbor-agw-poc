/**
 * Configuration, read once at start-up.
 *
 * Note what is *not* here: any Harbor credential. This server has no identity
 * of its own and cannot talk to Harbor on its own behalf. Every call it makes
 * carries the caller's token, forwarded by agentgateway. That is the whole
 * point of the exercise, so a `HARBOR_USERNAME` escape hatch would quietly
 * defeat it and is deliberately absent.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export interface Config {
  /** Base URL of the Harbor API host, e.g. https://harbor.192.168.1.201.nip.io */
  harborUrl: string;
  /** Port this MCP server listens on. */
  port: number;
  /** Bind address. 0.0.0.0 in a container. */
  host: string;
  /**
   * Accept requests that carry no bearer token.
   *
   * Off by default and it should stay off: agentgateway is what validates the
   * JWT, and a request that reaches here without one has bypassed it. Turning
   * this on is only useful when running the server directly for development.
   */
  allowAnonymous: boolean;
  /** Per-request timeout against the Harbor API, milliseconds. */
  harborTimeoutMs: number;
  /** Log every Harbor call. Noisy, but this is a lab. */
  debug: boolean;
}

export function loadConfig(): Config {
  const harborUrl = required("HARBOR_URL").replace(/\/+$/, "");

  return {
    harborUrl,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",
    allowAnonymous: optionalBool("ALLOW_ANONYMOUS", false),
    harborTimeoutMs: Number(process.env.HARBOR_TIMEOUT_MS ?? 15000),
    debug: optionalBool("DEBUG", false),
  };
}
