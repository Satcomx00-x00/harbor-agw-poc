/**
 * The upstream HTTP client.
 *
 * One instance per MCP request, holding that caller's token and dying with the
 * response. A shared client would have to keep tokens keyed by caller, and
 * every bug in that bookkeeping is one user acting as another — the failure
 * this whole design exists to prevent.
 *
 * What leaves the process credential-wise is decided by an UpstreamAuth
 * strategy, not by a branch in here. See auth.ts.
 */

import type { UpstreamAuth } from "./auth.js";
import type { Operation, ParamSpec } from "./spec.js";

export class UpstreamError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: string;

  constructor(status: number, method: string, url: string, body: string) {
    super(`${method} ${url} → HTTP ${String(status)}: ${truncate(body, 800)}`);
    this.name = "UpstreamError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }

  /** Something worth telling the model beyond the status code. */
  get hint(): string | undefined {
    switch (this.status) {
      case 401:
        return (
          "The upstream rejected the credential. With UPSTREAM_AUTH=oidc the " +
          "caller's token is forwarded as-is, so check the upstream accepts this " +
          "issuer and audience. With UPSTREAM_AUTH=none no credential is sent at " +
          "all, which is the likely cause if the upstream expects one."
        );
      case 403:
        return "Authenticated, but this identity is not allowed to do that upstream.";
      case 404:
        return (
          "Not found upstream. If the path looks right, the base URL may be " +
          "wrong — check UPSTREAM_BASE_URL against the document's own base."
        );
      default:
        return undefined;
    }
  }
}

/** A value was supplied where the URL can only carry a scalar. */
export class ParameterTypeError extends Error {
  constructor(param: ParamSpec, value: unknown) {
    super(
      `parameter "${param.name}" (${param.in}) must be a string, number or boolean, ` +
        `got ${describeType(value)}. Objects and arrays cannot be placed in a ` +
        `${param.in === "query" ? "single query value" : param.in} without an encoding ` +
        "the document does not specify.",
    );
    this.name = "ParameterTypeError";
  }
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : typeof v;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Render a value for a URL.
 *
 * The obvious `String(v)` is what this replaces, and it was a real defect: an
 * object argument became the literal "[object Object]" in a path or header, the
 * upstream answered 404 or 400, and nothing anywhere said the argument was the
 * wrong shape. Refusing is louder and always correct — a URL segment cannot
 * carry an object, so there is no right answer to fall back on.
 */
function scalar(param: ParamSpec, value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      throw new ParameterTypeError(param, value);
  }
}

export interface RequestPlan {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export interface ClientOptions {
  baseUrl: string;
  auth: UpstreamAuth;
  timeoutMs: number;
  debug?: boolean;
}

/**
 * Turn an operation and its arguments into a concrete request.
 *
 * Separate from sending it so the interesting half — path templating, query
 * encoding, which credential goes on — can be asserted in a unit test without
 * a server or a network.
 */
export function planRequest(
  options: ClientOptions,
  op: Operation,
  args: Readonly<Record<string, unknown>>,
  callerToken: string | undefined,
): RequestPlan {
  let path = op.path;
  for (const param of op.params) {
    if (param.in !== "path") continue;
    const value = args[param.name];
    if (value === undefined || value === null) {
      throw new Error(`missing required path parameter "${param.name}"`);
    }
    path = path.replaceAll(`{${param.name}}`, encodeURIComponent(scalar(param, value)));
  }

  const url = new URL(options.baseUrl + path);

  for (const param of op.params) {
    if (param.in !== "query") continue;
    const value = args[param.name];
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      // Repeated rather than comma-joined: that is what OpenAPI's default
      // `explode: true` means, and joining silently breaks any upstream that
      // does not expect a list in one value.
      for (const item of value) url.searchParams.append(param.name, scalar(param, item));
    } else {
      url.searchParams.set(param.name, scalar(param, value));
    }
  }

  const headers = new Headers({ accept: "application/json" });
  for (const param of op.params) {
    if (param.in !== "header") continue;
    const value = args[param.name];
    if (value === undefined || value === null) continue;
    headers.set(param.name, scalar(param, value));
  }

  let body: string | undefined;
  if (op.bodySchema && args.body !== undefined) {
    body = JSON.stringify(args.body);
    headers.set("content-type", "application/json");
  }

  // Last, and deliberately so: nothing above can overwrite the credential, and
  // a header parameter named "authorization" in some document cannot displace
  // it either.
  options.auth.authorize(headers, callerToken);

  return { url, method: op.method, headers, body };
}

export class UpstreamClient {
  readonly #options: ClientOptions;
  readonly #callerToken: string | undefined;

  constructor(options: ClientOptions, callerToken: string | undefined) {
    this.#options = options;
    this.#callerToken = callerToken;
  }

  async call(op: Operation, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const plan = planRequest(this.#options, op, args, this.#callerToken);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#options.timeoutMs);

    try {
      if (this.#options.debug === true) {
        console.error(
          `[upstream] ${plan.method} ${plan.url.pathname}${plan.url.search} ` +
            `auth=${this.#options.auth.mode}`,
        );
      }

      const res = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.body,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new UpstreamError(res.status, plan.method, plan.url.toString(), text);
      }
      if (text === "") return { status: res.status, body: null };

      if ((res.headers.get("content-type") ?? "").includes("json")) {
        try {
          return JSON.parse(text);
        } catch {
          // The Content-Type lied. Returning the text is more useful than failing.
          return text;
        }
      }
      return text;
    } catch (cause) {
      if (cause instanceof UpstreamError) throw cause;
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new Error(
          `upstream request timed out after ${String(this.#options.timeoutMs)}ms: ` +
            `${plan.method} ${plan.url.pathname}`,
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }
}
