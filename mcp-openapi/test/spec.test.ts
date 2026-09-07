import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./helpers.js";
import { asDocument } from "../src/openapi.js";
import {
  buildOperation,
  indexDocument,
  inputSchemaFor,
  parseDocument,
  toolNameFor,
  type LoadedSpec,
} from "../src/spec.js";
import { openapi3, swagger2, swagger2NoHost } from "./fixtures.js";

const index = (doc: unknown): LoadedSpec => indexDocument(asDocument(doc));

const op = (spec: LoadedSpec, key: string) => {
  const raw = spec.operations.get(key);
  assert.ok(raw, `no operation ${key}`);
  return buildOperation(raw, spec.adapter);
};

describe("parseDocument", () => {
  it("explains itself when handed YAML", () => {
    const err = caught(() => parseDocument("openapi: 3.0.0\n"));
    assert.match(err.message, /not JSON/);
    assert.match(err.message, /js-yaml/, "should say how to convert");
  });

  it("rejects JSON that is not an OpenAPI document", () => {
    assert.throws(() => parseDocument('{"hello":"world"}'), /paths/);
  });

  it("keeps the original error as the cause", () => {
    const err = caught(() => parseDocument("{not json"));
    assert.ok(err.cause instanceof Error, "the parse failure should not be swallowed");
  });
});

describe("dialect detection", () => {
  it("recognises OpenAPI 3", () => {
    assert.equal(index(openapi3).adapter.dialect, "openapi");
  });

  it("recognises Swagger 2.0", () => {
    assert.equal(index(swagger2).adapter.dialect, "swagger");
  });
});

describe("declared base URL", () => {
  it("reads servers[0].url for OpenAPI 3", () => {
    assert.equal(index(openapi3).declaredBaseUrl, "https://api.example.com/v1");
  });

  it("assembles scheme, host and basePath for Swagger 2.0", () => {
    assert.equal(index(swagger2).declaredBaseUrl, "http://localhost/v1");
  });

  it("falls back to a bare basePath when the document has no host", () => {
    assert.equal(index(swagger2NoHost).declaredBaseUrl, "/v1");
  });
});

describe("indexDocument", () => {
  for (const [name, doc] of [["OpenAPI 3", openapi3], ["Swagger 2.0", swagger2]] as const) {
    it(`finds every operation in ${name}`, () => {
      const spec = index(doc);
      assert.deepEqual(
        [...spec.operations.keys()].sort(),
        ["GET /health", "GET /widgets", "GET /widgets/{id}", "POST /widgets"],
      );
    });

    it(`inherits path-level parameters in ${name}`, () => {
      // trace-id is declared on the path, not the operation.
      const listed = op(index(doc), "GET /widgets");
      assert.ok(
        listed.params.some((p) => p.name === "trace-id" && p.in === "header"),
        "a path-level parameter must reach the operation",
      );
    });

    it(`treats a path parameter as required in ${name}`, () => {
      const single = op(index(doc), "GET /widgets/{id}");
      const id = single.params.find((p) => p.name === "id");
      assert.equal(id?.required, true, "the URL cannot be built without it");
    });

    it(`drops parameters it cannot honestly send in ${name}`, () => {
      // cookie (OpenAPI 3) and formData (Swagger 2.0). Sending either as a
      // query parameter would look like it worked.
      const created = op(index(doc), "POST /widgets");
      const fetched = op(index(doc), "GET /widgets/{id}");
      const names = [...created.params, ...fetched.params].map((p) => p.name);
      assert.ok(!names.includes("session"));
      assert.ok(!names.includes("avatar"));
    });
  }

  it("finds the request body in OpenAPI 3's requestBody", () => {
    const created = op(index(openapi3), "POST /widgets");
    assert.ok(created.bodySchema, "requestBody.content['application/json'].schema");
    assert.equal(created.bodyRequired, true);
  });

  it("finds the request body in Swagger 2.0's in:body parameter", () => {
    // The defect this test exists for: the first loader only looked at
    // requestBody, so every Swagger 2.0 body was silently ignored and POST
    // tools were generated that could not send anything.
    const created = op(index(swagger2), "POST /widgets");
    assert.ok(created.bodySchema, "the in:body parameter carries the schema");
    assert.equal(created.bodyRequired, true);
    assert.ok(
      !created.params.some((p) => p.name === "widget"),
      "the body must not also appear as an ordinary parameter",
    );
  });

  it("keeps Swagger 2.0 inline type keywords instead of flattening to string", () => {
    const listed = op(index(swagger2), "GET /widgets");
    const page = listed.params.find((p) => p.name === "page");
    assert.equal(page?.schema.type, "integer");
    assert.equal(page.schema.format, "int32");
    const sort = listed.params.find((p) => p.name === "sort");
    assert.deepEqual(sort?.schema.enum, ["asc", "desc"]);
  });
});

describe("toolNameFor", () => {
  const raw = (method: string, path: string, operationId?: string) => ({
    method,
    path,
    operationId,
    summary: undefined,
    description: undefined,
    parameters: [],
    object: {},
  });

  it("prefers the operationId, which is the API's own stable name", () => {
    assert.equal(toolNameFor(raw("GET", "/widgets", "listWidgets")), "listWidgets");
  });

  it("derives a name from method and path when there is no operationId", () => {
    assert.equal(toolNameFor(raw("GET", "/widgets/{id}")), "get_widgets_by_id");
  });

  it("applies a prefix", () => {
    assert.equal(toolNameFor(raw("GET", "/w", "listWidgets"), "api"), "api_listWidgets");
  });

  it("produces a name MCP accepts", () => {
    const name = toolNameFor(raw("GET", "/a b/c.d/{e}/~f"));
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  });

  it("truncates to 64 characters", () => {
    assert.equal(toolNameFor(raw("GET", `/${"x".repeat(200)}`)).length, 64);
  });

  it("is stable across calls, so a client's saved reference keeps working", () => {
    const a = toolNameFor(raw("GET", "/widgets/{id}"));
    const b = toolNameFor(raw("GET", "/widgets/{id}"));
    assert.equal(a, b);
  });
});

describe("inputSchemaFor", () => {
  it("puts each parameter under its own name and marks the required ones", () => {
    const schema = inputSchemaFor(op(index(openapi3), "GET /widgets/{id}"));
    assert.equal(schema.type, "object");
    const props = schema.properties as Record<string, { description?: string }>;
    assert.ok("id" in props);
    assert.deepEqual(schema.required, ["id"]);
    assert.match(props.id.description ?? "", /path parameter/);
  });

  it("carries the parameter's own schema through untouched", () => {
    const schema = inputSchemaFor(op(index(openapi3), "GET /widgets"));
    const props = schema.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.page?.type, "integer");
    assert.equal(props.tag?.type, "array");
  });

  it("exposes a request body as a `body` property", () => {
    const schema = inputSchemaFor(op(index(openapi3), "POST /widgets"));
    const props = schema.properties as Record<string, unknown>;
    assert.ok("body" in props);
    assert.ok((schema.required as string[]).includes("body"));
  });

  it("forbids unknown arguments", () => {
    // additionalProperties:false is what turns a typo in a tool call into a
    // validation error instead of a silently ignored argument.
    assert.equal(inputSchemaFor(op(index(openapi3), "GET /widgets")).additionalProperties, false);
  });

  it("omits `required` entirely when nothing is required", () => {
    const schema = inputSchemaFor(op(index(openapi3), "GET /health"));
    assert.ok(!("required" in schema));
  });
});
