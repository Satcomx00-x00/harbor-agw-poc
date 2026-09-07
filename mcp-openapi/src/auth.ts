/**
 * Strategy — what credential, if any, leaves this server.
 * https://refactoring.guru/design-patterns/strategy
 *
 * This was an `if (upstreamAuth === "oidc")` inside the request builder. Two
 * reasons it is a family of classes instead.
 *
 * It is the security-critical decision in the whole component, and it deserves
 * to be one small thing that can be read in full and tested in isolation,
 * rather than a branch buried in URL assembly.
 *
 * And it is the axis the server is expected to grow along: `static` for an API
 * key, `client_credentials` for a service token of its own. Each is a new class
 * implementing this interface, with no edit to the request path — which is
 * precisely the change Strategy is for.
 *
 * Note what none of them do: obtain a credential the caller did not have.
 * Inbound authentication is agentgateway's job and is never optional; these
 * only decide what is forwarded onward.
 */

export interface UpstreamAuth {
  /** Value for the config that selects this strategy. */
  readonly mode: string;

  /**
   * Apply the credential to an outgoing request.
   *
   * `headers` is mutated rather than returned, so a strategy that needs to
   * touch several headers is not forced to rebuild the object, and so a
   * strategy that touches none is visibly a no-op.
   */
  authorize(headers: Headers, callerToken: string | undefined): void;

  /** One line for the start-up log, so the running mode is never in doubt. */
  describe(): string;
}

/**
 * Forward the caller's own token.
 *
 * The upstream then sees the human who made the request, which is the whole
 * point of the chain this server sits in.
 */
export class OidcPassthroughAuth implements UpstreamAuth {
  readonly mode = "oidc";

  authorize(headers: Headers, callerToken: string | undefined): void {
    // No token is not this class's error to raise: index.ts already refuses
    // an unauthenticated request. If one arrives here regardless, sending the
    // request unauthenticated is safer than inventing a credential, and the
    // upstream's 401 says so plainly.
    if (callerToken !== undefined && callerToken !== "") {
      headers.set("authorization", `Bearer ${callerToken}`);
    }
  }

  describe(): string {
    return "forwarding the caller's token";
  }
}

/**
 * Send nothing.
 *
 * For an upstream that needs no credential. It does not make this server open:
 * a caller still has to authenticate to agentgateway to reach a tool at all.
 */
export class NoUpstreamAuth implements UpstreamAuth {
  readonly mode = "none";

  // Signature matched to the interface rather than trimmed to `()`. A shorter
  // one is legal TypeScript but makes the class uncallable through its own
  // type, which is exactly how a test found this.
  authorize(_headers: Headers, _callerToken: string | undefined): void {
    // Intentionally empty. The absence of a credential is the behaviour.
  }

  describe(): string {
    return "no credential sent upstream";
  }
}

export const UPSTREAM_AUTH_MODES = ["oidc", "none"] as const;
export type UpstreamAuthMode = (typeof UPSTREAM_AUTH_MODES)[number];

export function isUpstreamAuthMode(v: string): v is UpstreamAuthMode {
  return (UPSTREAM_AUTH_MODES as readonly string[]).includes(v);
}

/** Factory Method for the strategies above. */
export function createUpstreamAuth(mode: UpstreamAuthMode): UpstreamAuth {
  switch (mode) {
    case "oidc":
      return new OidcPassthroughAuth();
    case "none":
      return new NoUpstreamAuth();
  }
}
