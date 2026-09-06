/**
 * The allowlist: the file that decides what this server exposes.
 *
 * Everything in the OpenAPI document that is not matched here is invisible —
 * not listed, not callable, not reachable by guessing a tool name. That is the
 * point of the design: the spec describes what the service *can* do, the
 * allowlist decides what this deployment *may* do.
 *
 * Format, one rule per line:
 *
 *     # comments and blank lines are ignored
 *     GET  /api/v2.0/projects             method + path
 *     GET  /api/v2.0/search*              globs are allowed in the path
 *     ANY  /api/v2.0/health               ANY matches every method
 *     listRepositories                    a bare token is an operationId
 *     !GET /api/v2.0/users/{id}/secret    ! excludes, and beats every include
 *
 * Path matching is glob-based (picomatch), so `*` stops at a `/` and `**`
 * crosses it. Templated segments are matched literally as they appear in the
 * spec: write `{project_name}`, not `*`.
 *
 * An include rule that matches nothing is a hard error rather than a warning.
 * A typo in an allowlist should not silently produce a server with fewer tools
 * than intended — that failure is invisible until someone needs the tool.
 */

import picomatch from "picomatch";

export interface Rule {
  raw: string;
  line: number;
  negate: boolean;
  /** Uppercase HTTP method, or "ANY". Undefined for an operationId rule. */
  method: string | undefined;
  /** Path glob, for a method+path rule. */
  path: string | undefined;
  /** operationId glob, for a bare-token rule. */
  operationId: string | undefined;
}

const METHODS = new Set([
  "GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE", "ANY",
]);

export function parseAllowlist(text: string): Rule[] {
  const rules: Rule[] = [];

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    // Strip trailing comments, but only when introduced by whitespace: a '#'
    // can legitimately appear inside a path.
    const stripped = rawLine.replace(/\s+#.*$/, "").trim();
    if (!stripped || stripped.startsWith("#")) return;

    let body = stripped;
    let negate = false;
    if (body.startsWith("!")) {
      negate = true;
      body = body.slice(1).trim();
      if (!body) throw new Error(`allowlist line ${line}: "!" with nothing after it`);
    }

    const parts = body.split(/\s+/);
    const head = parts[0]!.toUpperCase();

    if (parts.length >= 2 && METHODS.has(head)) {
      const path = parts.slice(1).join(" ");
      if (!path.startsWith("/")) {
        throw new Error(
          `allowlist line ${line}: path must start with "/", got "${path}"`,
        );
      }
      rules.push({ raw: stripped, line, negate, method: head, path, operationId: undefined });
      return;
    }

    if (parts.length === 1) {
      if (body.startsWith("/")) {
        throw new Error(
          `allowlist line ${line}: "${body}" looks like a path but has no method. ` +
            `Write "GET ${body}", or "ANY ${body}" for every method.`,
        );
      }
      if (METHODS.has(head)) {
        throw new Error(`allowlist line ${line}: "${body}" is a method with no path`);
      }
      rules.push({ raw: stripped, line, negate, method: undefined, path: undefined, operationId: body });
      return;
    }

    throw new Error(
      `allowlist line ${line}: cannot parse "${stripped}". ` +
        `Expected "METHOD /path", "operationId", or either prefixed with "!".`,
    );
  });

  if (rules.every((r) => r.negate)) {
    throw new Error(
      "allowlist contains only exclusions, so nothing would be exposed. " +
        "Add at least one include rule.",
    );
  }

  return rules;
}

export interface Candidate {
  method: string;
  path: string;
  operationId: string | undefined;
}

function matches(rule: Rule, c: Candidate): boolean {
  if (rule.operationId !== undefined) {
    if (!c.operationId) return false;
    return picomatch.isMatch(c.operationId, rule.operationId);
  }
  if (rule.method !== "ANY" && rule.method !== c.method.toUpperCase()) return false;
  // dot: false — a path segment may contain dots ("/api/v2.0/...") and
  // picomatch would otherwise refuse to let `*` cross them.
  return picomatch.isMatch(c.path, rule.path!, { dot: true });
}

export interface Selection {
  selected: Candidate[];
  /** Include rules that matched nothing — always an error, see the note above. */
  deadRules: Rule[];
  /** Operations dropped by a `!` rule, kept for the start-up log. */
  excluded: { candidate: Candidate; rule: Rule }[];
}

export function applyAllowlist(rules: Rule[], candidates: Candidate[]): Selection {
  const includes = rules.filter((r) => !r.negate);
  const excludes = rules.filter((r) => r.negate);

  const selected: Candidate[] = [];
  const excluded: { candidate: Candidate; rule: Rule }[] = [];
  const used = new Set<Rule>();

  for (const c of candidates) {
    const inc = includes.find((r) => matches(r, c));
    if (!inc) continue;
    used.add(inc);

    // Exclusions win, unconditionally. An allowlist is read top to bottom by a
    // human, and "everything under /users except the secret" is the shape they
    // mean; making order decide would make it a puzzle.
    const exc = excludes.find((r) => matches(r, c));
    if (exc) {
      used.add(exc);
      excluded.push({ candidate: c, rule: exc });
      continue;
    }
    selected.push(c);
  }

  return {
    selected,
    deadRules: includes.filter((r) => !used.has(r)),
    excluded,
  };
}
