/**
 * The allowlist: the file that decides what this server exposes.
 *
 * Everything in the document that is not matched here is invisible — not
 * listed, not callable, not reachable by guessing a tool name. The document
 * describes what the service *can* do; this decides what this deployment *may*
 * do.
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
 * document: write `{project_name}`, not `*`.
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

export class AllowlistError extends Error {
  readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `allowlist line ${String(line)}: ${message}`);
    this.name = "AllowlistError";
    this.line = line;
  }
}

const METHODS: ReadonlySet<string> = new Set([
  "GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE", "ANY",
]);

function parseLine(rawLine: string, line: number): Rule | undefined {
  // Strip trailing comments, but only when introduced by whitespace: a '#' can
  // legitimately appear inside a path.
  const stripped = rawLine.replace(/\s+#.*$/, "").trim();
  if (stripped === "" || stripped.startsWith("#")) return undefined;

  const negate = stripped.startsWith("!");
  const body = negate ? stripped.slice(1).trim() : stripped;
  if (body === "") throw new AllowlistError('"!" with nothing after it', line);

  const parts = body.split(/\s+/);
  const [head, ...rest] = parts;
  if (head === undefined) throw new AllowlistError(`cannot parse "${stripped}"`, line);
  const method = head.toUpperCase();

  if (rest.length > 0 && METHODS.has(method)) {
    const path = rest.join(" ");
    if (!path.startsWith("/")) {
      throw new AllowlistError(`path must start with "/", got "${path}"`, line);
    }
    return { raw: stripped, line, negate, method, path, operationId: undefined };
  }

  if (rest.length === 0) {
    if (body.startsWith("/")) {
      throw new AllowlistError(
        `"${body}" looks like a path but has no method. Write "GET ${body}", ` +
          `or "ANY ${body}" for every method.`,
        line,
      );
    }
    if (METHODS.has(method)) {
      throw new AllowlistError(`"${body}" is a method with no path`, line);
    }
    return { raw: stripped, line, negate, method: undefined, path: undefined, operationId: body };
  }

  throw new AllowlistError(
    `cannot parse "${stripped}". Expected "METHOD /path", "operationId", ` +
      'or either prefixed with "!".',
    line,
  );
}

export function parseAllowlist(text: string): Rule[] {
  const rules: Rule[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const rule = parseLine(rawLine, index + 1);
    if (rule) rules.push(rule);
  });

  if (rules.length === 0) {
    throw new AllowlistError("the allowlist is empty, so nothing would be exposed");
  }
  if (rules.every((r) => r.negate)) {
    throw new AllowlistError(
      "the allowlist contains only exclusions, so nothing would be exposed. " +
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

export function matches(rule: Rule, candidate: Candidate): boolean {
  if (rule.operationId !== undefined) {
    if (candidate.operationId === undefined) return false;
    return picomatch.isMatch(candidate.operationId, rule.operationId);
  }
  if (rule.path === undefined) return false;
  if (rule.method !== "ANY" && rule.method !== candidate.method.toUpperCase()) return false;
  // dot: true — a path segment may contain dots ("/api/v2.0/...") and picomatch
  // would otherwise refuse to let `*` cross them.
  return picomatch.isMatch(candidate.path, rule.path, { dot: true });
}

export interface Selection {
  selected: Candidate[];
  /** Include rules that matched nothing. Always an error; see registry.ts. */
  deadRules: Rule[];
  excluded: { candidate: Candidate; rule: Rule }[];
}

export function applyAllowlist(rules: readonly Rule[], candidates: readonly Candidate[]): Selection {
  const includes = rules.filter((r) => !r.negate);
  const excludes = rules.filter((r) => r.negate);

  const selected: Candidate[] = [];
  const excluded: { candidate: Candidate; rule: Rule }[] = [];
  const usedIncludes = new Set<Rule>();

  for (const candidate of candidates) {
    const include = includes.find((r) => matches(r, candidate));
    if (!include) continue;
    usedIncludes.add(include);

    // Exclusions win unconditionally. An allowlist is read top to bottom by a
    // human, and "everything under /users except the secret" is the shape they
    // mean; making order decide would make it a puzzle.
    const exclude = excludes.find((r) => matches(r, candidate));
    if (exclude) {
      excluded.push({ candidate, rule: exclude });
      continue;
    }
    selected.push(candidate);
  }

  return {
    selected,
    deadRules: includes.filter((r) => !usedIncludes.has(r)),
    excluded,
  };
}
