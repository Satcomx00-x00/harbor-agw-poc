#!/usr/bin/env bash
# Scaffold a new mcp-openapi package: the whole directory tree, ready to build.
#
# What it writes is split in two on purpose.
#
#   Complete    package.json, the three tsconfigs, Dockerfile, .dockerignore,
#               .gitignore, an allowlist example. These carry no decisions of
#               yours and are copied verbatim from the reference package.
#   Contracts   src/*.ts and test/*.ts, each an empty module holding the
#               responsibility of the file and the exports it owes its callers.
#
# The stubs are comments, not fake implementations: `npm run typecheck` passes
# on a fresh scaffold, and nothing pretends to work that does not.
#
#   ./scripts/scaffold-mcp-openapi.sh -o ../mcp-stripe -n mcp-stripe
#
# Deliberately standalone — no lib.sh, no lab.env, no cluster. Scaffolding a
# package must not require a lab to be up.
set -Eeuo pipefail

OUT="./mcp-openapi"
NAME=""
FORCE=0
DRY=0

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
note() { printf '  %s %s\n' "$1" "$2"; }

usage() {
  cat <<'USAGE'
scaffold-mcp-openapi.sh — create the file tree of an mcp-openapi package

  -o, --out DIR     where to write it        (default: ./mcp-openapi)
  -n, --name NAME   package + MCP server id  (default: basename of --out)
  -f, --force       overwrite existing files (default: skip them)
      --dry-run     list what would be written, write nothing
  -h, --help        this

Every file is skipped if it already exists, so a re-run adds what is missing
without touching your work. --force is the opposite and says so per file.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)   OUT="${2:-}"; [ -n "$OUT" ] || die "--out needs a directory"; shift 2 ;;
    -n|--name)  NAME="${2:-}"; [ -n "$NAME" ] || die "--name needs a value"; shift 2 ;;
    -f|--force) FORCE=1; shift ;;
    --dry-run)  DRY=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$NAME" ] || NAME="$(basename -- "$OUT")"
# The name lands in package.json and in a sed replacement, so it is constrained
# rather than trusted: npm's own rule, minus the scope syntax.
[[ "$NAME" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "invalid --name '$NAME' (lowercase letters, digits, . _ -)"

WRITTEN=0 SKIPPED=0

# write <relative path> — content on stdin. __NAME__ is substituted.
write() {
  local rel="$1" path="$OUT/$1"
  if [ -e "$path" ] && [ "$FORCE" -eq 0 ]; then
    cat >/dev/null; SKIPPED=$((SKIPPED + 1)); note "skip " "$rel"; return 0
  fi
  local verb="write"; [ -e "$path" ] && verb="over "
  if [ "$DRY" -eq 1 ]; then cat >/dev/null; note "$verb" "$rel"; WRITTEN=$((WRITTEN + 1)); return 0; fi
  mkdir -p -- "$(dirname -- "$path")"
  sed "s/__NAME__/$NAME/g" > "$path"
  WRITTEN=$((WRITTEN + 1)); note "$verb" "$rel"
}

# stub <relative path> <one-line responsibility> <export…>
#
# One function for all 20 source files, because a stub that varies per file is
# a stub someone has to read twice. What differs — the contract — is arguments.
stub() {
  local rel="$1" purpose="$2"; shift 2
  local body
  # Built into a variable, not piped: a pipeline would run write() in a
  # subshell and its counters would die with it.
  body="$(
    printf '/**\n'
    # Wrapped to the repo's column, so a scaffolded header reads like a written
    # one rather than a single line running off the screen.
    printf '%s\n' "$purpose" | fold -s -w 76 | sed -e 's/[[:space:]]*$//' -e 's|^| * |'
    if [ $# -gt 0 ]; then
      printf ' *\n * Owes its callers:\n'
      local item
      for item in "$@"; do
        # Folded per item, with continuations indented deeper, so a wrapped
        # entry cannot be misread as a second one.
        printf '%s\n' "$item" | fold -s -w 70 | sed -e 's/[[:space:]]*$//' \
          -e '1s|^| *   |' -e '2,$s|^| *     |'
      done
    fi
    printf ' */\n\nexport {};'
  )"
  write "$rel" <<< "$body"
}

printf '\033[1mscaffolding %s\033[0m (name: %s)\n' "$OUT" "$NAME"

# ── the files that carry no decision of yours ───────────────────────────────

write package.json <<'EOF'
{
  "name": "__NAME__",
  "version": "0.1.0",
  "private": true,
  "description": "Template MCP server: turns any OpenAPI document into MCP tools, restricted to an explicit allowlist",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.test.json && node --test \".test-build/test/**/*.test.js\"",
    "test:coverage": "tsc -p tsconfig.test.json && node --test --experimental-test-coverage \".test-build/test/**/*.test.js\"",
    "generate:types": "openapi-typescript \"$OPENAPI_SPEC\" -o src/generated/schema.d.ts"
  },
  "dependencies": {
    "@apidevtools/json-schema-ref-parser": "16.0.2",
    "@modelcontextprotocol/sdk": "1.30.0",
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1",
    "express": "5.2.1",
    "picomatch": "4.0.7"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "26.4.1",
    "@types/picomatch": "4.0.3",
    "openapi-typescript": "7.13.0",
    "typescript": "5.9.3"
  }
}
EOF

write tsconfig.json <<'EOF'
{
  "compilerOptions": {
    // No rootDir/outDir: this config is for ESLint's type-aware rules, the
    // editor and `npm run typecheck`, and covers src/ and test/ together.
    // Emit is tsconfig.build.json (src -> dist) and tsconfig.test.json.
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true,
    "erasableSyntaxOnly": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
EOF

write tsconfig.build.json <<'EOF'
{
  // Production emit: src only.
  //
  // tsconfig.json deliberately includes test/ as well, because ESLint's
  // type-aware rules and the editor both need every file to belong to a
  // project. Emitting from it would put the tests in dist/, which the
  // Kubernetes manifests copy verbatim.
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
EOF

write tsconfig.test.json <<'EOF'
{
  // Tests compile to their own tree.
  //
  // Node does not rewrite a ".js" import specifier to the ".ts" file beside it,
  // so `node --test test/*.ts` cannot work while src/ uses the TypeScript
  // convention of importing "./x.js". Compiling both into one tree sidesteps
  // that without changing a single import in src/, and without disturbing the
  // production build, whose dist/ layout the Kubernetes manifests depend on.
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": ".test-build",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
EOF

write Dockerfile <<'EOF'
# Two stages so the runtime image carries no compiler and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Non-root. The image needs no write access anywhere at runtime.
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
EOF

write .dockerignore <<'EOF'
node_modules
dist
*.log
.git
.test-build
EOF

write .gitignore <<'EOF'
node_modules
dist
.test-build
src/generated
*.log
EOF

write examples/httpbin.allowlist.txt <<'EOF'
# httpbin.org — a starter allowlist, and the UPSTREAM_AUTH=none case.
#
# One rule per line. This file is the whole access-control surface: an
# operation that is not matched is not listed, not callable, and not reachable
# by guessing a tool name.
#
#   GET  /users/current          method + path, as written in the document
#   GET  /search*                globs allowed (* stops at /, ** crosses it)
#   ANY  /health                 every method on that path
#   listRepositories             a bare token is an operationId
#   !GET /users/{id}/secret      ! excludes, and beats every include
#
# An include rule that matches nothing stops the server from starting, so a
# typo is a boot failure rather than a silently missing tool.

GET /get
GET /status/{code}
GET /headers
EOF

write README.md <<'EOF'
# __NAME__

An MCP server built from an OpenAPI document and an allowlist. No code is
written per service: point it at a different document and it becomes a
different server.

```
OPENAPI_SPEC        openapi.json — a path, or a URL fetched at start-up
OPENAPI_ALLOWLIST   the only thing that decides the exposed surface
UPSTREAM_BASE_URL   overrides the document's origin, keeps its path
UPSTREAM_AUTH       oidc | none
MCP_TOOL_PREFIX     namespaces this server's tool names
PORT                default 8080
```

## The two authentications

| | who enforces it | when |
|---|---|---|
| inbound, caller → MCP | the gateway, against the identity provider | always |
| outbound, MCP → service | this server, per `UPSTREAM_AUTH` | depends on the service |

`UPSTREAM_AUTH=none` means the *upstream* needs no credential. It never means
the caller needs none: a request without a bearer token is refused with 401
whatever this setting says. The server holds no credential of its own in
either mode.

## Layout

```
src/openapi.ts     structural types for the document, and guards to reach them
src/adapters.ts    one interface over OpenAPI 3 and Swagger 2.0
src/spec.ts        load a document, index it, build operations
src/allowlist.ts   parse the rules, apply them, fail loudly on a dead one
src/registry.ts    document + allowlist -> the fixed set of tools
src/auth.ts        what credential, if any, leaves this process
src/client.ts      the upstream HTTP client, one per caller
src/base-url.ts    where requests actually go
src/config.ts      environment, read once at start-up
src/index.ts       wiring and HTTP, no decisions
```

## Build

```bash
npm ci
npm run typecheck
npm test
npm run build && npm start
```
EOF

# ── the files that are yours to write ───────────────────────────────────────

stub src/openapi.ts \
  "Structural types for the parts of an OpenAPI document this server reads, and the guards that get from \`unknown\` to them. Partial and structural on purpose: the goal is not to model OpenAPI, it is to make every field this server touches one the compiler knows about." \
  "type JsonSchema, HTTP_METHODS, type HttpMethod" \
  "interfaces RawParameter, RawOperationObject, RawPathItem, RawDocument" \
  "guards asDocument, asParameter, isPathItem, isOperationObject, str"

stub src/adapters.ts \
  "Adapter — one interface over two document dialects. OpenAPI 3 and Swagger 2.0 describe the same things differently: the base URL, the request body, where a parameter's type lives. Everything that asks which dialect it has belongs here and nowhere else." \
  "interfaces BodySpec, SpecAdapter" \
  "classes OpenApi3Adapter, Swagger2Adapter" \
  "selectAdapter(doc), collectParameters(raw)"

stub src/spec.ts \
  "Loading a document and turning it into the operations this server exposes. The tool surface is built here, from the document, at start-up — there is no generated per-service code and nothing hand-written about any particular API." \
  "interfaces ParamSpec, Operation, RawOperation, LoadedSpec" \
  "loadText, parseDocument, indexDocument, loadSpec" \
  "toolNameFor, buildOperation, inputSchemaFor"

stub src/allowlist.ts \
  "The allowlist: the file that decides what this server exposes. The document describes what the service *can* do; this decides what this deployment *may* do. An include rule matching nothing is a start-up failure, because the alternative is a missing tool nobody notices until the day it is needed." \
  "interfaces Rule, Candidate, Selection" \
  "class AllowlistError" \
  "parseAllowlist, matches, applyAllowlist"

stub src/registry.ts \
  "Document plus allowlist to the fixed set of tools this process serves, each with its arguments compiled to an ajv validator. Its own module so that \"this document and this allowlist produce exactly these tools\" is a unit test rather than something observed in a log." \
  "interfaces Tool, Registry" \
  "class RegistryError" \
  "buildRegistry(spec, rules, prefix)"

stub src/auth.ts \
  "Strategy — what credential, if any, leaves this server. The security-critical decision of the whole component, so it is one small thing that can be read in full and tested in isolation rather than a branch buried in URL assembly." \
  "interface UpstreamAuth" \
  "classes OidcPassthroughAuth, NoUpstreamAuth" \
  "UPSTREAM_AUTH_MODES, type UpstreamAuthMode, isUpstreamAuthMode, createUpstreamAuth"

stub src/client.ts \
  "The upstream HTTP client. One instance per MCP request, holding that caller's token and dying with the response — a shared client would key tokens by caller, and every bug in that bookkeeping is one user acting as another. What leaves the process credential-wise is decided by an UpstreamAuth strategy, not by a branch in here." \
  "classes UpstreamError, ParameterTypeError, UpstreamClient" \
  "interfaces RequestPlan, ClientOptions" \
  "planRequest(operation, args, options)"

stub src/base-url.ts \
  "Where upstream requests actually go. An override replaces the origin and keeps the document's path: dropping the path lands every request on a web portal that answers 200 with HTML, which reads like an auth failure and is not. The resolution is returned in words so it can be logged." \
  "interfaces BaseUrlInput, BaseUrlResolution" \
  "class BaseUrlError" \
  "resolveBaseUrl(input)"

stub src/config.ts \
  "Configuration, read once at start-up. Two files decide everything this server does: an OpenAPI document and an allowlist. Point them at a different service and it becomes a different MCP server, with no code change." \
  "interface Config" \
  "loadConfig() — reads OPENAPI_SPEC, OPENAPI_ALLOWLIST, UPSTREAM_BASE_URL, UPSTREAM_AUTH, MCP_TOOL_PREFIX, MCP_SERVER_NAME, PORT"

stub src/index.ts \
  "Entry point: wiring and HTTP, with no decision of its own. Boots the registry, then serves POST /mcp statelessly — a fresh server per request with the caller's token in a closure that dies with the response — plus /healthz, /readyz and /tools for debugging without an MCP client. Refuses a request that carries no bearer token, whatever UPSTREAM_AUTH says."

stub test/helpers.ts \
  "Shared test helpers." \
  "caught<T extends Error>(fn, ctor) — run fn, return the error it threw, fail if it did not"

stub test/fixtures.ts \
  "Two documents describing the same tiny API, one per dialect. Written by hand rather than trimmed from a real spec, so every field present is one a test asserts on and the dialect differences sit side by side." \
  "openapi3, swagger2, swagger2NoHost"

stub test/openapi.test.ts \
  "The guards: what asDocument accepts, and what it refuses with a message that names the field."

stub test/adapters.test.ts \
  "The two dialect adapters through their own interface. A third dialect should be addable by writing a class and a block here, with nothing else touched."

stub test/spec.test.ts \
  "parseDocument, dialect detection, the declared base URL, indexDocument, tool naming, and the input schema built for an operation."

stub test/allowlist.test.ts \
  "parseAllowlist on every rule form and every malformed one, matches per rule, and applyAllowlist — including the dead-include-rule failure, which is the property worth protecting."

stub test/registry.test.ts \
  "A document and an allowlist in, exactly these tools out. The single most important property of the component."

stub test/base-url.test.ts \
  "resolveBaseUrl: document only, override of the origin, an override carrying its own path, and the inputs that are errors."

stub test/client.test.ts \
  "The auth strategies and planRequest, with no I/O: what URL is built, and which headers do and do not leave the process under each mode."

stub test/upstream-client.test.ts \
  "UpstreamClient.call against a real socket — status mapping, content types, timeouts. What only happens once a response comes back."

stub test/server.test.ts \
  "Component smoke test. Starts a stub upstream, spawns the real server against it, and drives it over HTTP exactly as the gateway would. Nothing mocked inside the server, so it catches what unit tests structurally cannot: the boot sequence, the transport, and what actually leaves the process on the wire."

printf '\n\033[32mdone\033[0m %d written, %d skipped\n' "$WRITTEN" "$SKIPPED"
[ "$DRY" -eq 1 ] && exit 0

cat <<EOF

next:
  cd $OUT
  npm install
  npm run typecheck        # passes on a fresh scaffold: the stubs are comments
  # then fill src/, in dependency order: openapi -> adapters -> spec ->
  # allowlist -> registry -> auth/client/base-url/config -> index
EOF
