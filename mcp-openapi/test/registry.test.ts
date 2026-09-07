import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./helpers.js";
import { asDocument } from "../src/openapi.js";
import { indexDocument } from "../src/spec.js";
import { buildRegistry, RegistryError } from "../src/registry.js";
import { openapi3 } from "./fixtures.js";

const spec = indexDocument(asDocument(openapi3));
const build = (allowlist: string, prefix?: string) => buildRegistry(spec, allowlist, prefix);

describe("buildRegistry", () => {
  it("exposes exactly what the allowlist selects", () => {
    // The single most important property of this component.
    const registry = build("GET /widgets\nGET /health");
    assert.deepEqual([...registry.tools.keys()].sort(), ["get_health", "listWidgets"].sort());
  });

  it("does not expose a sibling operation that was not listed", () => {
    const registry = build("GET /widgets");
    assert.ok(!registry.tools.has("createWidget"), "POST /widgets is in the document");
    assert.equal(registry.tools.size, 1);
  });

  it("applies a tool prefix", () => {
    const registry = build("GET /widgets", "api");
    assert.deepEqual([...registry.tools.keys()], ["api_listWidgets"]);
  });

  it("compiles a validator that accepts good arguments", () => {
    const tool = build("GET /widgets/{id}").tools.get("getWidget");
    assert.ok(tool);
    assert.equal(tool.validate({ id: "abc" }), true);
  });

  it("compiles a validator that rejects a missing required argument", () => {
    const tool = build("GET /widgets/{id}").tools.get("getWidget");
    assert.ok(tool);
    assert.equal(tool.validate({}), false);
  });

  it("compiles a validator that rejects an unknown argument", () => {
    const tool = build("GET /widgets/{id}").tools.get("getWidget");
    assert.ok(tool);
    assert.equal(tool.validate({ id: "a", nope: 1 }), false);
  });

  it("coerces a stringified number, because MCP arguments arrive as JSON", () => {
    const tool = build("GET /widgets").tools.get("listWidgets");
    assert.ok(tool);
    assert.equal(tool.validate({ page: "2" }), true);
  });

  it("refuses to start on a rule that matches nothing", () => {
    // A typo in an allowlist otherwise yields a server with fewer tools than
    // intended, and that stays invisible until someone needs the missing one.
    const err = caught(
      () => build("GET /widgets\nGET /widgts"),
      RegistryError,
    );
    assert.match(err.message, /matched no operation/);
    assert.match(err.message, /GET \/widgts/);
    assert.match(err.message, /line 2/);
  });

  it("refuses to start when the allowlist selects nothing at all", () => {
    caught(() => build("GET /widgets\n!GET /widgets"), RegistryError);
  });

  it("reports what an exclusion removed", () => {
    const registry = build("ANY /widgets\n!POST /widgets");
    assert.equal(registry.excluded.length, 1);
    assert.equal(registry.excluded[0]?.method, "POST");
  });

  it("refuses two operations that would collapse to one tool name", () => {
    // Silently keeping one would make the other unreachable, and which one
    // wins would depend on iteration order.
    const collide = indexDocument(
      asDocument({
        openapi: "3.0.3",
        info: { title: "x", version: "1" },
        paths: {
          "/a": { get: { operationId: "same" } },
          "/b": { get: { operationId: "same" } },
        },
      }),
    );
    const err = caught(
      () => buildRegistry(collide, "GET /a\nGET /b"),
      RegistryError,
    );
    assert.match(err.message, /duplicate tool name "same"/);
    assert.match(err.message, /MCP_TOOL_PREFIX/, "should say how to fix it");
  });

  it("selects by operationId as well as by path", () => {
    const registry = build("listWidgets");
    assert.deepEqual([...registry.tools.keys()], ["listWidgets"]);
  });
});
