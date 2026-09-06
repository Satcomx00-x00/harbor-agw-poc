/**
 * The upstream HTTP client, built from the OpenAPI document at start-up.
 *
 * One instance per MCP request, holding that caller's token in a closure and
 * dying with the response. A shared client would have to keep tokens somewhere
 * keyed by caller, and every bug in that bookkeeping is one user acting as
 * another — the failure this whole design exists to prevent.
 */

import type { Config } from "./config.js";
import type { Operation } from "./spec.js";

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${method} ${url} → HTTP ${status}: ${truncate(body, 800)}`);
    this.name = "UpstreamError";
  }

  /** Something worth telling the model beyond the status code. */
  get hint(): string | undefined {
    if (this.status === 401) {
      return (
        "The upstream rejected the credential. With UPSTREAM_AUTH=oidc the " +
        "caller's token is forwarded as-is, so check the upstream accepts this " +
        "issuer and audience. With UPSTREAM_AUTH=none no credential is sent at " +
        "all, which is the likely cause if the upstream expects one."
      );
    }
    if (this.status === 403) {
      return "Authenticated, but this identity is not allowed to do that upstream.";
    }
    if (this.status === 404) {
      return (
        "Not found upstream. If the path looks right, the base URL may be " +
        "wrong — check UPSTREAM_BASE_URL against the spec's servers[] entry."
      );
    }
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export class UpstreamClient {
  constructor(
    private readonly cfg: Config,
    private readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {}

  async call(op: Operation, args: Record<string, unknown>): Promise<unknown> {
    // Path parameters first: the URL cannot be built without them, and a
    // missing one would otherwise be sent as the literal "{id}".
    let path = op.path;
    for (const p of op.params.filter((x) => x.in === "path")) {
      const v = args[p.name];
      if (v === undefined || v === null) {
        throw new Error(`missing required path parameter "${p.name}"`);
      }
      path = path.replace(
        new RegExp(`\\{${escapeRe(p.name)}\\}`, "g"),
        encodeURIComponent(String(v)),
      );
    }

    const url = new URL(this.baseUrl + path);

    for (const p of op.params.filter((x) => x.in === "query")) {
      const v = args[p.name];
      if (v === undefined || v === null || v === "") continue;
      // An array query parameter is repeated rather than joined: that is what
      // OpenAPI's default `explode: true` means, and joining silently breaks
      // any upstream that does not expect a comma-separated list.
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(p.name, String(item));
      } else if (typeof v === "object") {
        url.searchParams.set(p.name, JSON.stringify(v));
      } else {
        url.searchParams.set(p.name, String(v));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };

    for (const p of op.params.filter((x) => x.in === "header")) {
      const v = args[p.name];
      if (v !== undefined && v !== null) headers[p.name] = String(v);
    }

    // The one place the outbound credential is decided.
    if (this.cfg.upstreamAuth === "oidc" && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    // UPSTREAM_AUTH=none deliberately falls through with no Authorization
    // header. The caller was still authenticated by agentgateway to get here.

    let body: string | undefined;
    if (op.bodySchema && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers["Content-Type"] = "application/json";
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.requestTimeoutMs);

    try {
      if (this.cfg.debug) {
        console.error(
          `[upstream] ${op.method} ${url.pathname}${url.search} ` +
            `auth=${this.cfg.upstreamAuth}${this.cfg.upstreamAuth === "oidc" ? (this.token ? "(token)" : "(no token!)") : ""}`,
        );
      }

      const res = await fetch(url, {
        method: op.method,
        headers,
        body,
        signal: ac.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new UpstreamError(res.status, op.method, url.toString(), text);
      if (!text) return { status: res.status, body: null };

      const type = res.headers.get("content-type") ?? "";
      if (type.includes("json")) {
        try {
          return JSON.parse(text);
        } catch {
          // Content-Type lied. Returning the text is more useful than failing.
          return text;
        }
      }
      return text;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `upstream request timed out after ${this.cfg.requestTimeoutMs}ms: ${op.method} ${path}`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
