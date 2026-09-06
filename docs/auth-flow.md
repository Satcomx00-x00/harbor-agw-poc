# How one token crosses four systems

The question this lab exists to answer: **when an agent calls a tool, does the
registry know who asked?**

The usual answer is no. An MCP server holds a service account, every user's
tool call arrives at the backend as that one identity, and the audit log says
`mcp-bot` did everything. Here the caller's own credential travels the whole
way, and Harbor's `/users/current` returns the human.

```
  MCP client
      │  Authorization: Bearer <id_token>
      ▼
  agentgateway                    validates: iss, sig, aud ∋ mcp-gateway
      │  same token, unmodified   (mcpAuthentication: strict
      ▼                            + backendAuth: passthrough)
  mcp-harbor                      holds no credentials of its own
      │  same token, unmodified
      ▼
  Harbor API                      validates: iss, sig, aud ∋ harbor
                                  then resolves (iss, sub) → a Harbor user
```

## The audience problem, and the fix

Both agentgateway and Harbor check the `aud` claim, and they want different
values. A token minted for one is rejected by the other.

Three ways out. Token exchange at the gateway (an extra round trip and a
Keycloak preview feature). Two tokens (the MCP server then needs a credential
to obtain the second, which reintroduces exactly the service account this lab
is trying to avoid). Or one token with both audiences — which is what OIDC's
`aud` being a *list* is for.

The `mcp` client in `deploy/10-keycloak/realm-lab.json` carries two audience
mappers:

| mapper | adds | consumed by |
|---|---|---|
| `audience-harbor` | `harbor` | Harbor's ID-token middleware |
| `audience-mcp-gateway` | `mcp-gateway` | agentgateway's `mcpAuthentication.audiences` |

Both set `id.token.claim: "true"`, which matters: Harbor authenticates with the
**ID token**, not the access token. A token issued to user `dev` comes out as

```json
{
  "iss": "https://keycloak.192.168.1.200.nip.io/realms/lab",
  "aud": ["mcp", "harbor", "mcp-gateway"],
  "azp": "mcp",
  "preferred_username": "dev"
}
```

`mcp` is there because Keycloak always includes the requesting client. The other
two are the mappers. Every validator finds what it is looking for and none of
them has to know about the others.

## What each hop actually checks

**agentgateway** — `deploy/40-agentgateway/config.yaml`

`mcpAuthentication` in `strict` mode: no token, or a bad one, is a 401 before
anything is proxied. `issuer` is the public Keycloak URL because that is what
lands in `iss`; `jwks.url` points at the in-cluster Service instead, over plain
HTTP, so the gateway does not need the lab CA. The two fields are separate
precisely so they can disagree about transport while agreeing about identity.

Then `backendAuth: passthrough: {}`. Without it agentgateway strips the
credential after validating — its default, and the right one in general, since
a backend usually has no business seeing the client's token. Here it is the
whole point.

**mcp-harbor** — `mcp-harbor/src/index.ts`

Checks only that a token is *present*, and lets Harbor be the authority on
whether it is any good. Harbor has to make that call regardless; a second
opinion here would only be a staler one.

The transport runs stateless: a fresh `McpServer` per POST, with the token in a
closure that dies with the response. A long-lived server with sessions would
have to keep tokens in a map keyed by session id, and every bug in that
bookkeeping is one user reading another user's registry.

**Harbor** — `oidc_auth` mode

Verifies the ID token against Keycloak, then looks the caller up by
`(issuer, subject)`.

## The trap: Harbor will not onboard from a bearer token

A valid token for a user Harbor has never seen returns 401, and the core log
says:

```
server/middleware/security/idtoken.go:53
failed to get user based on token claims: oidc info for user with issuer
https://keycloak.../realms/lab, subject 2e49dcd8-... not found
```

`oidc_auto_onboard: true` does not help. Onboarding happens **only** in the
authorization-code callback — the browser flow. A user who has never opened the
Harbor UI can never use the API.

`scripts/onboard-harbor-user.py` drives that flow with an HTTP client: hit
`/c/oidc/login`, scrape Keycloak's login form (its action URL carries a one-shot
`session_code`, `execution` and `tab_id` and cannot be constructed), post the
credentials, follow the redirect back into `/c/oidc/callback`. Harbor exchanges
the code, creates the `oidc_user` row, and from then on bearer tokens work.

It is idempotent, so `scripts/30-onboard.sh` can be re-run.

## Proving it end to end

`scripts/smoke-test.py` asserts the parts that are easy to assume:

- an unauthenticated call is refused **at the gateway**, not deeper in
- a garbage token is refused too (so the 401 is validation, not a missing header)
- the ID token really carries both audiences
- a full MCP handshake completes through the gateway
- `harbor_whoami` returns **the caller's** username
- two different users get two different Harbor identities, which is what rules
  out a shared service account somewhere in the middle

That last pair is the one worth keeping. Everything else can pass while a
service account quietly does the work.
