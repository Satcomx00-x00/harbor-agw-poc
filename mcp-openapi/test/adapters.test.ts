/**
 * The two dialect adapters, exercised directly.
 *
 * spec.test.ts covers them through the loader, which is how they are used; this
 * covers them through their own interface, which is what makes the Adapter
 * pattern worth having. A third dialect should be addable by writing a class
 * and a block here, with nothing else touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectParameters,
  OpenApi3Adapter,
  selectAdapter,
  Swagger2Adapter,
  type SpecAdapter,
} from "../src/adapters.js";
import type { RawDocument, RawOperationObject } from "../src/openapi.js";

describe("selectAdapter", () => {
  it("picks Swagger 2.0 from the `swagger` marker", () => {
    assert.equal(selectAdapter({ swagger: "2.0" }).dialect, "swagger");
  });

  it("picks OpenAPI 3 from the `openapi` marker", () => {
    assert.equal(selectAdapter({ openapi: "3.1.0" }).dialect, "openapi");
  });

  it("assumes OpenAPI 3 when a document says neither", () => {
    // Everything published since 2017 is 3.x, so that is the safer guess than
    // refusing to load.
    assert.equal(selectAdapter({}).dialect, "openapi");
  });
});

describe("declaredBaseUrl", () => {
  const cases: [string, SpecAdapter, RawDocument, string | undefined][] = [
    [
      "OpenAPI 3 reads servers[0].url",
      new OpenApi3Adapter(),
      { servers: [{ url: "https://api.example.com/v1" }] },
      "https://api.example.com/v1",
    ],
    ["OpenAPI 3 with no servers has nothing to say", new OpenApi3Adapter(), {}, undefined],
    [
      "Swagger 2.0 assembles scheme, host and basePath",
      new Swagger2Adapter(),
      { schemes: ["https"], host: "api.example.com", basePath: "/v1" },
      "https://api.example.com/v1",
    ],
    [
      "Swagger 2.0 defaults to https when no scheme is given",
      new Swagger2Adapter(),
      { host: "api.example.com", basePath: "/v1" },
      "https://api.example.com/v1",
    ],
    [
      "Swagger 2.0 returns a bare basePath when there is no host",
      new Swagger2Adapter(),
      { basePath: "/api/v2.0" },
      "/api/v2.0",
    ],
    ["Swagger 2.0 with neither has nothing to say", new Swagger2Adapter(), {}, undefined],
  ];

  for (const [name, adapter, doc, expected] of cases) {
    it(name, () => {
      assert.equal(adapter.declaredBaseUrl(doc), expected);
    });
  }
});

describe("body", () => {
  const schema = { type: "object" };

  it("OpenAPI 3 reads requestBody.content['application/json']", () => {
    const op: RawOperationObject = {
      requestBody: { required: true, content: { "application/json": { schema } } },
    };
    assert.deepEqual(new OpenApi3Adapter().body(op), { schema, required: true });
  });

  it("OpenAPI 3 accepts any JSON-ish media type", () => {
    const op: RawOperationObject = {
      requestBody: { content: { "application/merge-patch+json": { schema } } },
    };
    assert.deepEqual(new OpenApi3Adapter().body(op), { schema, required: false });
  });

  it("OpenAPI 3 ignores a body this client cannot encode", () => {
    // Guessing an encoding for multipart would produce a request the upstream
    // rejects for reasons that look nothing like "wrong content type".
    const op: RawOperationObject = {
      requestBody: { content: { "multipart/form-data": { schema } } },
    };
    assert.equal(new OpenApi3Adapter().body(op), undefined);
  });

  it("Swagger 2.0 reads the in:body parameter", () => {
    const params = collectParameters([{ name: "payload", in: "body", required: true, schema }]);
    assert.deepEqual(new Swagger2Adapter().body({}, params), { schema, required: true });
  });

  it("Swagger 2.0 has no body when no parameter declares one", () => {
    const params = collectParameters([{ name: "page", in: "query", type: "integer" }]);
    assert.equal(new Swagger2Adapter().body({}, params), undefined);
  });
});

describe("parameterSchema", () => {
  it("OpenAPI 3 uses the parameter's schema", () => {
    const [param] = collectParameters([
      { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
    ]);
    assert.deepEqual(new OpenApi3Adapter().parameterSchema(param!), { type: "integer", minimum: 1 });
  });

  it("OpenAPI 3 falls back to string when a parameter has no schema", () => {
    const [param] = collectParameters([{ name: "q", in: "query" }]);
    assert.deepEqual(new OpenApi3Adapter().parameterSchema(param!), { type: "string" });
  });

  it("Swagger 2.0 rebuilds a schema from the parameter's own keywords", () => {
    // Defaulting to { type: "string" } instead would throw away enums and
    // formats the document took the trouble to state.
    const [param] = collectParameters([
      { name: "sort", in: "query", type: "string", enum: ["asc", "desc"], format: "x" },
    ]);
    assert.deepEqual(new Swagger2Adapter().parameterSchema(param!), {
      type: "string",
      format: "x",
      enum: ["asc", "desc"],
    });
  });

  it("Swagger 2.0 assumes string when the parameter states no type", () => {
    const [param] = collectParameters([{ name: "q", in: "query" }]);
    assert.deepEqual(new Swagger2Adapter().parameterSchema(param!), { type: "string" });
  });
});

describe("collectParameters", () => {
  it("keeps well-formed parameters", () => {
    assert.equal(collectParameters([{ name: "a", in: "query" }]).length, 1);
  });

  it("drops entries that are not parameters, rather than refusing to start", () => {
    // A document may carry vendor extensions here. Failing over one would make
    // this server useless against a large share of real specs.
    const params = collectParameters([
      { name: "a", in: "query" },
      { "x-vendor": true },
      null,
      "nonsense",
      { name: "b" },
      { name: "c", in: "not-a-location" },
    ]);
    assert.deepEqual(params.map((p) => p.name), ["a"]);
  });
});
