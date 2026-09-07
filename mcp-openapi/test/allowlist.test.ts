import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./helpers.js";
import {
  AllowlistError,
  applyAllowlist,
  matches,
  parseAllowlist,
  type Candidate,
} from "../src/allowlist.js";

const candidates: Candidate[] = [
  { method: "GET", path: "/users/current", operationId: "getCurrentUserInfo" },
  { method: "GET", path: "/projects", operationId: "listProjects" },
  { method: "POST", path: "/projects", operationId: "createProject" },
  { method: "GET", path: "/projects/{project_name}/repositories", operationId: "listRepositories" },
  { method: "DELETE", path: "/projects/{project_name}", operationId: "deleteProject" },
  { method: "GET", path: "/api/v2.0/search", operationId: "search" },
  { method: "GET", path: "/health", operationId: undefined },
];

/** Join rules with real newlines here so the tests read like a real file. */
const lines = (...rules: string[]): string => rules.join("\n");

const select = (text: string): string[] =>
  applyAllowlist(parseAllowlist(text), candidates).selected.map((c) => `${c.method} ${c.path}`);

describe("parseAllowlist", () => {
  it("ignores blank lines, comments and trailing comments", () => {
    const rules = parseAllowlist(
      lines("# a header", "", "GET /projects   # why we expose it", "   ", "# trailing"),
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.path, "/projects");
  });

  it("keeps a '#' that is part of a path", () => {
    assert.equal(parseAllowlist("GET /weird/#fragment")[0]?.path, "/weird/#fragment");
  });

  it("reads a bare token as an operationId", () => {
    const rules = parseAllowlist("listProjects");
    assert.equal(rules[0]?.operationId, "listProjects");
    assert.equal(rules[0].method, undefined);
  });

  it("reads a leading ! as an exclusion", () => {
    // Paired with an include, because an allowlist of only exclusions is
    // refused: it would expose nothing.
    const rules = parseAllowlist(lines("GET /ok", "!GET /secret"));
    assert.equal(rules[1]?.negate, true);
    assert.equal(rules[1].path, "/secret");
  });

  it("uppercases the method", () => {
    assert.equal(parseAllowlist("get /projects")[0]?.method, "GET");
  });

  it("reports the line number on a bad rule", () => {
    const err = caught(() => parseAllowlist(lines("GET /ok", "", "/projects")), AllowlistError);
    assert.equal(err.line, 3);
    // The message should say what to write, not just that it is wrong.
    assert.match(err.message, /GET \/projects/);
  });

  it("rejects a method with no path", () => {
    assert.throws(() => parseAllowlist("GET"), AllowlistError);
  });

  it("rejects a path that does not start with /", () => {
    assert.throws(() => parseAllowlist("GET projects"), AllowlistError);
  });

  it("rejects a bare !", () => {
    assert.throws(() => parseAllowlist("!"), AllowlistError);
  });

  it("rejects an empty allowlist, which would expose nothing", () => {
    assert.throws(() => parseAllowlist(lines("# only comments", "")), AllowlistError);
  });

  it("rejects an allowlist of only exclusions, which would expose nothing", () => {
    assert.throws(() => parseAllowlist(lines("!GET /a", "!GET /b")), AllowlistError);
  });
});

describe("matches", () => {
  const rule = (text: string) => parseAllowlist(text)[0]!;

  it("matches method and path exactly", () => {
    assert.equal(matches(rule("GET /projects"), candidates[1]!), true);
    assert.equal(matches(rule("GET /projects"), candidates[2]!), false, "POST is not GET");
  });

  it("ANY matches every method", () => {
    assert.equal(matches(rule("ANY /projects"), candidates[1]!), true);
    assert.equal(matches(rule("ANY /projects"), candidates[2]!), true);
  });

  it("a * does not cross a /", () => {
    assert.equal(matches(rule("GET /projects/*"), candidates[3]!), false);
    assert.equal(matches(rule("GET /projects/**"), candidates[3]!), true);
  });

  it("a * crosses a dot, because paths contain version numbers", () => {
    // Regression guard: picomatch's default `dot: false` would refuse to let
    // `*` match "v2.0", which silently drops every path under /api/v2.0.
    assert.equal(matches(rule("GET /api/*/search"), candidates[5]!), true);
  });

  it("matches a templated segment literally, not as a wildcard", () => {
    assert.equal(matches(rule("GET /projects/{project_name}/repositories"), candidates[3]!), true);
    assert.equal(matches(rule("GET /projects/anything/repositories"), candidates[3]!), false);
  });

  it("matches an operationId, and never matches one that is absent", () => {
    assert.equal(matches(rule("listProjects"), candidates[1]!), true);
    assert.equal(matches(rule("list*"), candidates[3]!), true);
    assert.equal(matches(rule("anything"), candidates[6]!), false, "no operationId to match");
  });
});

describe("applyAllowlist", () => {
  it("selects only what is listed", () => {
    assert.deepEqual(select(lines("GET /projects", "GET /health")), [
      "GET /projects",
      "GET /health",
    ]);
  });

  it("does not expose a sibling method that was not listed", () => {
    // The property the whole component rests on: POST /projects exists in the
    // document and must not appear because only GET was asked for.
    assert.deepEqual(select("GET /projects"), ["GET /projects"]);
  });

  it("applies an exclusion regardless of rule order", () => {
    const after = select(
      lines("GET /projects/**", "!GET /projects/{project_name}/repositories"),
    );
    const before = select(
      lines("!GET /projects/{project_name}/repositories", "GET /projects/**"),
    );
    assert.ok(!after.includes("GET /projects/{project_name}/repositories"));
    assert.deepEqual(before, after, "order must not change the outcome");
  });

  it("a trailing /** also matches the parent path itself", () => {
    // Worth pinning down, because it decides what an allowlist actually grants:
    // `GET /projects/**` covers `/projects` as well as everything beneath it.
    // Someone expecting only the subtree would be exposing one endpoint more
    // than they meant to.
    assert.ok(select("GET /projects/**").includes("GET /projects"));
  });

  it("reports which rule excluded what", () => {
    const result = applyAllowlist(
      parseAllowlist(lines("ANY /projects", "!POST /projects")),
      candidates,
    );
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0]?.candidate.method, "POST");
    assert.equal(result.excluded[0].rule.raw, "!POST /projects");
  });

  it("reports a rule that matched nothing", () => {
    // This is the check that turns an allowlist typo into a start-up failure
    // instead of a tool that quietly does not exist.
    const result = applyAllowlist(
      parseAllowlist(lines("GET /projects", "GET /typo")),
      candidates,
    );
    assert.equal(result.deadRules.length, 1);
    assert.equal(result.deadRules[0]?.raw, "GET /typo");
  });

  it("does not count an exclusion as a dead rule", () => {
    const result = applyAllowlist(
      parseAllowlist(lines("GET /projects", "!GET /nothing")),
      candidates,
    );
    assert.deepEqual(result.deadRules, []);
  });
});
