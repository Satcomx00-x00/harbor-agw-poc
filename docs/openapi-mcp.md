# mcp-openapi — any API, as MCP tools, on an allowlist

A template MCP server. Give it an OpenAPI document and a text file listing
endpoints; it exposes those endpoints as MCP tools and nothing else. No code is
written per service.

```
OPENAPI_SPEC        openapi.json — a path, or a URL fetched at start-up
OPENAPI_ALLOWLIST   allowlist.txt — the only thing that decides the surface
UPSTREAM_BASE_URL   overrides the document's origin
UPSTREAM_AUTH       oidc | none
```

## The two authentications

The distinction that matters, and the one that is easy to collapse by accident:

| | who enforces it | when |
|---|---|---|
| **inbound**, caller → MCP | agentgateway, against Keycloak | **always** |
| **outbound**, MCP → service | this server, per `UPSTREAM_AUTH` | depends on the service |

`UPSTREAM_AUTH=none` means *the upstream service needs no credential*. It never
means the caller needs none: a request that arrives without a bearer token is
refused with 401 whatever this setting says. The server has no credentials of
its own in either mode — with `oidc` it forwards the caller's token, with `none`
it sends nothing.

Demonstrated against Harbor with `UPSTREAM_AUTH=none`:

```
no token                   -> HTTP 401          the caller is still required
tools/call getHealth       -> {"components":…}  needs no upstream credential
tools/call getCurrentUser  -> HTTP 401 upstream nothing was forwarded
```

That third line is the proof. The call was authorised — the caller had a valid
Keycloak token — and Harbor still rejected it, because in `none` mode no
`Authorization` header leaves this process.

## The allowlist

One rule per line. The file is the whole access-control surface: an operation
that is not matched is not listed, not callable, and not reachable by guessing
a tool name.

```
# comments and blank lines are ignored
GET  /users/current                 method + path
GET  /projects/{project_name}/repositories
GET  /search*                       globs are allowed
ANY  /health                        every method on that path
listRepositories                    a bare token is an operationId
!GET /users/{user_id}/secret        ! excludes, and beats every include
```

Paths are matched as they appear in the document — write `{project_name}`, not
`*`. Globs use picomatch: `*` stops at a `/`, `**` crosses it.

**An include rule that matches nothing stops the server from starting.** That is
deliberate. A typo in an allowlist otherwise produces a server with fewer tools
than intended, and that failure is invisible until the day someone needs the
missing one.

```
[boot] allowlist rules that matched no operation in the spec:
  line 7: GET /project/{id}
```

Exclusions always win over includes, regardless of order, so
"everything under `/users` except the secret" reads the way it is written.

## What it does at start-up

1. Fetch the document (file or URL) and dereference every `$ref`, so what
   follows deals in plain JSON Schema.
2. Detect **OpenAPI 3 or Swagger 2.0**. Both are supported; Harbor, among many
   others, still publishes 2.0.
3. Apply the allowlist. Refuse to start on a dead rule or an empty selection.
4. Resolve the base URL (below).
5. Build one tool per selected operation, with a JSON Schema for its arguments
   taken straight from the document.
6. Compile each schema with ajv, so bad arguments are rejected before a request
   is made.

Tool names come from `operationId` when the document has one, otherwise from
method + path. `MCP_TOOL_PREFIX` namespaces them.

### Why JSON Schema passes through untouched

The SDK's high-level `McpServer` takes Zod and converts it to JSON Schema. Here
the JSON Schema already exists — it is what OpenAPI parameters *are* — so
converting it to Zod and back could only lose fidelity: formats, enums, nested
object constraints. This server therefore uses the SDK's low-level `Server` and
hands the document's schemas to MCP verbatim.

### Base URL resolution

`UPSTREAM_BASE_URL` overrides the **origin**; the document keeps its **path**.

That split is not fussiness. Harbor's document says `host: localhost` with
`basePath: /api/v2.0` — the host is a placeholder, the path is authoritative.
Overriding the whole URL drops `/api/v2.0`, every request lands on the web
portal, and tools return a page of HTML that reads like an auth failure and is
not. An override that carries its own path is taken verbatim; the operator was
explicit.

The resolution is logged, because a silently computed URL is the one thing you
cannot debug from outside:

```
[boot] base URL: origin from UPSTREAM_BASE_URL + path "/api/v2.0" from the spec
```

## Running several

One document per instance. agentgateway multiplexes them behind a single MCP
endpoint, so adding a service is a Deployment plus a target:

```yaml
- mcp:
    prefixMode: never
    targets:
      - name: harbor
        mcp: { host: mcp-harbor.mcp.svc.cluster.local,  port: 8080, path: /mcp }
      - name: openapi
        mcp: { host: mcp-openapi.mcp.svc.cluster.local, port: 8080, path: /mcp }
```

`prefixMode: never` keeps tool names as each server emits them. The default
(`always`) would produce `harbor_harbor_whoami`, since mcp-harbor already
namespaces its own tools, and `conditional` does the same here — it prefixes
whenever there is more than one target. `never` requires names to be unique
across targets, so that is guaranteed at the source rather than hoped for:
mcp-harbor emits `harbor_*`, mcp-openapi is given `MCP_TOOL_PREFIX=openapi`.

**Restart order matters.** agentgateway reads each target's tool list when it
initialises. Change a backend's tools and restart the gateway *after* the
backend is serving, or it caches the old list:

```bash
kubectl -n mcp rollout status deploy/mcp-openapi
kubectl -n mcp rollout restart deploy/agentgateway
```

## Point it somewhere else

```yaml
env:
  - { name: OPENAPI_SPEC,      value: "https://api.example.com/openapi.json" }
  - { name: OPENAPI_ALLOWLIST, value: "/etc/mcp/allowlist.txt" }
  - { name: UPSTREAM_BASE_URL, value: "https://api.example.com" }
  - { name: UPSTREAM_AUTH,     value: "none" }
  - { name: MCP_TOOL_PREFIX,   value: "example" }
```

Plus a ConfigMap holding the allowlist. That is the whole per-service
configuration.

## Debugging without an MCP client

`GET /tools` lists what the allowlist selected:

```bash
kubectl -n mcp port-forward deploy/mcp-openapi 8080:8080
curl -s localhost:8080/tools | jq
curl -s localhost:8080/healthz | jq
```

## Limits worth knowing

- **JSON request bodies only.** `formData` and `multipart` parameters are
  dropped rather than half-supported — sending them as query parameters would
  look like it worked.
- **No cookie parameters**, for the same reason: there is no cookie jar here.
- **JSON documents only.** Convert YAML first (`npx js-yaml x.yaml > x.json`);
  the error message says so.
- **The document is read once, at start-up.** A spec served from a URL is not
  re-fetched; restart the pod to pick up changes.
- **`openapi-typescript` is a devDependency, not the runtime path.**
  `npm run generate:types` emits compile-time types when the target is known in
  advance. It cannot participate at runtime, because a document fetched from a
  URL is not available at build time — which is exactly the case this server is
  built for.
