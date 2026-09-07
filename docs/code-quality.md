# Code quality: the tooling, and what it found

Three gates, all runnable from the repository root:

```bash
npm run lint     # eslint + typescript-eslint, type-aware
npm run knip     # dead exports and unused dependencies
npm --prefix mcp-openapi test
```

Current state: **0 lint findings, 0 knip findings, 139 tests, 91% line coverage.**

---

## The tooling

**typescript-eslint at `strictTypeChecked`**, not `recommended`. The rules that
earn their keep here are the ones that need the type checker —
`no-floating-promises`, `no-unsafe-member-access`, `no-base-to-string`,
`no-unnecessary-condition`. Those find defects in async server code, which is
all this repository is.

**knip** for exports nothing imports and dependencies nothing uses. Its value
turned out to be indirect: most of what it flagged was code that *should* have
had a test and did not.

**`node:test`**, no test framework dependency. Node 24 runs it, reports
coverage, and needs nothing installed.

**`erasableSyntaxOnly: true`.** TypeScript parameter properties
(`constructor(private readonly x: T)`) cannot be stripped by Node's native
TypeScript support, so the codebase does not use them. That keeps the door open
to running `.ts` directly and, more immediately, makes every field declaration
visible at the top of its class rather than hidden in a parameter list.

---

## What the first run found

91 findings. The distribution was the useful part:

| file | findings |
|---|---|
| `mcp-openapi/src/spec.ts` | **59** |
| `mcp-openapi/src/index.ts` | 11 |
| everything else | 21 |

Two thirds sat in one file, and that file was the one walking a parsed JSON
document with `any`. It was also the file where both real defects found during
deployment had already come from — a Swagger 2.0 request body silently ignored,
and a base path silently dropped. Neither was caught by the compiler, because
with `any` there is nothing to catch.

That is the finding worth keeping: the lint count did not point at sloppiness,
it pointed at the place where the type system had been switched off.

### Defects, as opposed to style

**`String(v)` on a value that might be an object** (`client.ts`, three places,
`no-base-to-string`). An object argument became the literal `[object Object]` in
a URL path or header; the upstream answered 404 or 400, and nothing said the
argument had the wrong shape. Now a `ParameterTypeError` says exactly that. A
URL segment cannot carry an object, so there was never a right answer to fall
back on.

**Errors rethrown without a `cause`** (`preserve-caught-error`, two places). The
timeout message replaced the abort instead of wrapping it, so the original was
gone by the time anyone read the log.

**`Server` is deprecated** (`no-deprecated`). Worth checking rather than
suppressing: `McpServer.registerTool` types `inputSchema` as
`ZodRawShapeCompat | AnySchema`, and `AnySchema` is `z3.ZodTypeAny |
z4.$ZodType` — Zod only. The schemas here are already JSON Schema, which is
also what MCP puts on the wire, so McpServer would force JSON Schema → Zod →
JSON Schema and lose formats and nested constraints in the middle. The
deprecation notice says "only use `Server` for advanced use cases"; this is one.
Suppressed at the use site with that reasoning written down.

**An interface a class could not satisfy through its own type.** `NoUpstreamAuth`
declared `authorize(): void` where the interface has two parameters. Legal
TypeScript, and it made the class uncallable through its own type — found by a
test, not by the linter.

---

## Patterns

Two, both because they removed a branch that was going to be forgotten.

**Adapter** — `src/adapters.ts`.
[refactoring.guru/design-patterns/adapter](https://refactoring.guru/design-patterns/adapter)

OpenAPI 3 and Swagger 2.0 disagree about where the base URL lives, where the
request body lives, and where a parameter's type lives. That was
`if (flavour === "swagger")` scattered through the loader. Each dialect now sits
behind one interface, the loader never asks which it has, and OpenAPI 3.1 —
which differs again on `nullable` and `exclusiveMinimum` — is a new class rather
than a hunt for every branch.

**Strategy** — `src/auth.ts`.
[refactoring.guru/design-patterns/strategy](https://refactoring.guru/design-patterns/strategy)

What credential leaves the process was an `if` inside URL assembly. It is the
security-critical decision in the component and deserves to be one small thing
that can be read in full and tested alone. It is also the axis this will grow
along: `static` for an API key, `client_credentials` for a service token, each a
new class with no edit to the request path.

**Factory Method** picks both (`selectAdapter`, `createUpstreamAuth`), which is
what keeps the choice in one place instead of at every call site.

A third refactor was not a pattern at all, just extraction: `base-url.ts`,
`registry.ts` and `openapi.ts` came out of the boot sequence so they could be
tested without a socket. That is what took `index.ts` from 344 lines of mixed
concerns to wiring.

---

## The tests

139, in about 1.2 seconds.

| suite | what it pins down |
|---|---|
| `allowlist` | parsing, globs, exclusions, dead rules |
| `adapters` | each dialect through its own interface |
| `spec` | both dialects through the loader, tool naming, input schemas |
| `base-url` | origin/path resolution, including the Harbor case |
| `client` | request planning, and what each auth strategy attaches |
| `upstream-client` | responses, error mapping, timeouts, against a real socket |
| `registry` | document + allowlist → exactly these tools |
| `server` | the real binary, spawned, driven over HTTP |

Coverage is 91% of lines. `index.ts` sits at 23% because it is exercised only by
the spawned-process test, which the in-process instrumentation cannot see —
worth stating rather than papering over with a number.

### Tests written against defects

Several exist because something broke in the cluster first, and those carry a
comment saying so:

- a Swagger 2.0 `in: body` parameter must produce a body
- a `*` must cross a dot, or every path under `/api/v2.0` silently disappears
- an override must not drop the document's base path
- `UPSTREAM_AUTH=none` must send nothing *even when a token is present*
- a header parameter named `authorization` must not displace the credential

### Two the tests found on their own

`/projects/**` also matches `/projects` itself. Not a bug, but it decides what
an allowlist grants, so it is now pinned by a test with the reasoning attached.

And `assert.throws` is typed `void`, so `assert.throws(...) as Error` is a lie
the compiler rejects. `test/helpers.ts` has a `caught()` that returns the error
instead, which is what a test actually wants to assert on.
