import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./helpers.js";
import {
  createUpstreamAuth,
  isUpstreamAuthMode,
  NoUpstreamAuth,
  OidcPassthroughAuth,
} from "../src/auth.js";
import { ParameterTypeError, planRequest, type ClientOptions } from "../src/client.js";
import { asDocument } from "../src/openapi.js";
import { buildOperation, indexDocument, type Operation } from "../src/spec.js";
import { openapi3 } from "./fixtures.js";

const spec = indexDocument(asDocument(openapi3));

function operation(key: string): Operation {
  const raw = spec.operations.get(key);
  assert.ok(raw, `no operation ${key}`);
  return buildOperation(raw, spec.adapter);
}

const options = (mode: "oidc" | "none" = "oidc"): ClientOptions => ({
  baseUrl: "https://api.example.com/v1",
  auth: createUpstreamAuth(mode),
  timeoutMs: 1000,
});

describe("auth strategies", () => {
  it("oidc forwards the caller's token", () => {
    const headers = new Headers();
    new OidcPassthroughAuth().authorize(headers, "abc.def.ghi");
    assert.equal(headers.get("authorization"), "Bearer abc.def.ghi");
  });

  it("oidc sends nothing rather than inventing a credential when there is no token", () => {
    const headers = new Headers();
    new OidcPassthroughAuth().authorize(headers, undefined);
    assert.equal(headers.get("authorization"), null);
  });

  it("none sends nothing even when a token is available", () => {
    // The property the mode exists for: the caller was authenticated to reach
    // this server, and their credential still must not leave it.
    const headers = new Headers();
    new NoUpstreamAuth().authorize(headers, "abc.def.ghi");
    assert.equal(headers.get("authorization"), null);
  });

  it("only recognises the modes it implements", () => {
    assert.equal(isUpstreamAuthMode("oidc"), true);
    assert.equal(isUpstreamAuthMode("none"), true);
    assert.equal(isUpstreamAuthMode("bearer"), false);
  });
});

describe("planRequest", () => {
  it("substitutes path parameters and percent-encodes them", () => {
    const plan = planRequest(options(), operation("GET /widgets/{id}"), { id: "a/b" }, undefined);
    assert.equal(plan.url.pathname, "/v1/widgets/a%2Fb");
  });

  it("refuses when a path parameter is missing", () => {
    assert.throws(
      () => planRequest(options(), operation("GET /widgets/{id}"), {}, undefined),
      /missing required path parameter "id"/
    );
  });

  it("adds query parameters and skips absent ones", () => {
    const plan = planRequest(options(), operation("GET /widgets"), { page: 2 }, undefined);
    assert.equal(plan.url.searchParams.get("page"), "2");
    assert.equal(plan.url.searchParams.get("tag"), null);
  });

  it("repeats an array query parameter rather than joining it", () => {
    // OpenAPI's default is explode: true. Joining with commas silently breaks
    // any upstream that expects repetition.
    const plan = planRequest(
      options(),
      operation("GET /widgets"),
      { tag: ["red", "blue"] },
      undefined,
    );
    assert.deepEqual(plan.url.searchParams.getAll("tag"), ["red", "blue"]);
  });

  it("sends header parameters as headers", () => {
    const plan = planRequest(options(), operation("GET /widgets"), { "trace-id": "t-1" }, undefined);
    assert.equal(plan.headers.get("trace-id"), "t-1");
  });

  it("refuses an object where the URL can only carry a scalar", () => {
    // The defect this replaced: String({}) produced the literal "[object
    // Object]" in the path, the upstream answered 404, and nothing said the
    // argument had the wrong shape.
    const err = caught(
      () => planRequest(options(), operation("GET /widgets/{id}"), { id: { a: 1 } }, undefined),
      ParameterTypeError,
    );
    assert.match(err.message, /an object/);
    assert.ok(!err.message.includes("[object Object]"));
  });

  it("refuses an object inside an array query parameter too", () => {
    assert.throws(
      () => planRequest(options(), operation("GET /widgets"), { tag: [{ a: 1 }] }, undefined),
      ParameterTypeError,
    );
  });

  it("accepts numbers and booleans", () => {
    const plan = planRequest(options(), operation("GET /widgets/{id}"), { id: 7 }, undefined);
    assert.equal(plan.url.pathname, "/v1/widgets/7");
  });

  it("serialises a JSON body and sets the content type", () => {
    const plan = planRequest(
      options(),
      operation("POST /widgets"),
      { body: { name: "bolt" } },
      undefined,
    );
    assert.equal(plan.body, '{"name":"bolt"}');
    assert.equal(plan.headers.get("content-type"), "application/json");
  });

  it("sends no body when the operation declares none", () => {
    const plan = planRequest(options(), operation("GET /widgets"), { body: { a: 1 } }, undefined);
    assert.equal(plan.body, undefined);
  });

  it("attaches the caller's token under UPSTREAM_AUTH=oidc", () => {
    const plan = planRequest(options("oidc"), operation("GET /widgets"), {}, "tok");
    assert.equal(plan.headers.get("authorization"), "Bearer tok");
  });

  it("attaches nothing under UPSTREAM_AUTH=none", () => {
    const plan = planRequest(options("none"), operation("GET /widgets"), {}, "tok");
    assert.equal(plan.headers.get("authorization"), null);
  });

  it("does not let a header parameter displace the credential", () => {
    // A document is free to declare a header called "authorization". The
    // strategy runs last precisely so it cannot be overwritten by one.
    const withAuthHeader = {
      ...operation("GET /widgets"),
      params: [
        {
          name: "authorization",
          in: "header" as const,
          required: false,
          schema: { type: "string" },
          description: undefined,
        },
      ],
    };
    const plan = planRequest(options("oidc"), withAuthHeader, { authorization: "Basic evil" }, "tok");
    assert.equal(plan.headers.get("authorization"), "Bearer tok");
  });

  it("keeps the base URL's own path prefix", () => {
    const plan = planRequest(options(), operation("GET /widgets"), {}, undefined);
    assert.equal(plan.url.pathname, "/v1/widgets");
  });
});
