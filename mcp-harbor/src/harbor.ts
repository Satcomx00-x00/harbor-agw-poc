/**
 * Harbor API v2.0 client, bound to one caller's token.
 *
 * A client instance is created per MCP request and dies with it. It holds the
 * bearer token in a closure rather than on a shared singleton, which is what
 * makes it impossible for one caller's credential to be used for another's
 * tool call — the failure mode that matters most in a gateway-fronted MCP
 * server, and one that is easy to introduce by caching a client.
 *
 * On the token itself: when Harbor runs with `auth_mode: oidc_auth` its API
 * accepts `Authorization: Bearer <token>` where the token is the OIDC **ID
 * token**, not the access token. Harbor verifies it against its configured
 * OIDC provider and requires `aud` to contain Harbor's own client id, which is
 * why the Keycloak realm adds `harbor` as an extra audience on tokens issued
 * to the MCP client. See docs/auth-flow.md.
 */

import type { Config } from "./config.js";

export class HarborError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Harbor ${String(status)} on ${path}: ${truncate(body, 500)}`);
    this.name = "HarborError";
  }

  /** A hint worth surfacing to the model rather than a bare 401. */
  get hint(): string | undefined {
    if (this.status === 401) {
      return (
        "Harbor rejected the token. Usual causes: the access token was sent " +
        "instead of the ID token; the token's `aud` does not contain Harbor's " +
        "client id; or the token expired."
      );
    }
    if (this.status === 403) {
      return "Authenticated, but this user has no permission on that resource in Harbor.";
    }
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export interface Paging {
  page?: number;
  pageSize?: number;
}

export class HarborClient {
  constructor(
    private readonly cfg: Config,
    private readonly token: string | undefined,
  ) {}

  private async request<T>(
    path: string,
    init: { method?: string; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.cfg.harborUrl}/api/v2.0${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
    }, this.cfg.harborTimeoutMs);

    try {
      if (this.cfg.debug) {
        console.error(`[harbor] ${init.method ?? "GET"} ${url.pathname}${url.search}`);
      }

      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        signal: ac.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new HarborError(res.status, url.pathname, text);
      return (text ? JSON.parse(text) : null) as T;
    } catch (cause) {
      if (cause instanceof HarborError) throw cause;
      if (cause instanceof Error && cause.name === "AbortError") {
        // `cause` preserves the abort for anything reading the chain; the
        // message states the budget, which the AbortError does not.
        throw new Error(
          `Harbor request timed out after ${String(this.cfg.harborTimeoutMs)}ms: ${path}`,
          { cause },
        );
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The identity Harbor resolved from the forwarded token.
   *
   * The most useful tool in the set, because it is the one that proves the
   * whole chain: a name here means the token survived agentgateway, reached
   * this server, and was accepted by Harbor as a user rather than as a shared
   * service account.
   */
  whoami() {
    return this.request<Record<string, unknown>>("/users/current");
  }

  listProjects(opts: Paging & { name?: string; owner?: string } = {}) {
    return this.request<unknown[]>("/projects", {
      query: {
        page: opts.page,
        page_size: opts.pageSize,
        name: opts.name,
        owner: opts.owner,
      },
    });
  }

  listRepositories(project: string, opts: Paging & { q?: string } = {}) {
    return this.request<unknown[]>(`/projects/${enc(project)}/repositories`, {
      query: { page: opts.page, page_size: opts.pageSize, q: opts.q },
    });
  }

  listArtifacts(project: string, repository: string, opts: Paging & { withTag?: boolean } = {}) {
    return this.request<unknown[]>(
      `/projects/${enc(project)}/repositories/${enc(repository)}/artifacts`,
      {
        query: {
          page: opts.page,
          page_size: opts.pageSize,
          with_tag: String(opts.withTag ?? true),
        },
      },
    );
  }

  getArtifact(project: string, repository: string, reference: string) {
    return this.request<Record<string, unknown>>(
      `/projects/${enc(project)}/repositories/${enc(repository)}/artifacts/${enc(reference)}`,
      { query: { with_tag: "true", with_label: "true", with_scan_overview: "true" } },
    );
  }

  search(q: string) {
    return this.request<Record<string, unknown>>("/search", { query: { q } });
  }

  systemInfo() {
    return this.request<Record<string, unknown>>("/systeminfo");
  }
}

/**
 * Harbor addresses a repository by the part of its name *after* the project:
 * the repository `library/nginx` in project `library` is `nginx`, but
 * `library/team/app` is `team/app`. That remainder still occupies a single
 * path segment, so its slashes have to be percent-encoded or Harbor answers
 * 404 and it reads like "no such repository" rather than a URL problem.
 */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}
