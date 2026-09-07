import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { caught } from "./helpers.js";
import { BaseUrlError, resolveBaseUrl } from "../src/base-url.js";

describe("resolveBaseUrl", () => {
  it("uses the document when there is no override", () => {
    const r = resolveBaseUrl({ declared: "https://api.example.com/v1", override: undefined });
    assert.equal(r.url, "https://api.example.com/v1");
  });

  it("keeps the document's path when the override is an origin", () => {
    // The Harbor case, and the defect this function was extracted for. Harbor's
    // document declares `host: localhost` with `basePath: /api/v2.0`: the host
    // is a placeholder, the path is authoritative. Dropping the path sends
    // every request to the web portal, which answers 200 with HTML — a failure
    // that looks like anything but a URL problem.
    const r = resolveBaseUrl({
      declared: "http://localhost/api/v2.0",
      override: "https://harbor.example.com",
    });
    assert.equal(r.url, "https://harbor.example.com/api/v2.0");
    assert.match(r.reason, /path "\/api\/v2\.0"/);
  });

  it("keeps a bare base path when the document has no host at all", () => {
    const r = resolveBaseUrl({ declared: "/api/v2.0", override: "https://harbor.example.com" });
    assert.equal(r.url, "https://harbor.example.com/api/v2.0");
  });

  it("lets an override with its own path win over the document", () => {
    const r = resolveBaseUrl({
      declared: "http://localhost/api/v2.0",
      override: "https://harbor.example.com/custom",
    });
    assert.equal(r.url, "https://harbor.example.com/custom");
    assert.match(r.reason, /carries its own path/);
  });

  it("ignores a trailing slash on either side", () => {
    const r = resolveBaseUrl({ declared: "/api/v2.0/", override: "https://h.example.com/" });
    assert.equal(r.url, "https://h.example.com/api/v2.0");
  });

  it("does not duplicate the path when the override already ends with it", () => {
    const r = resolveBaseUrl({
      declared: "/api/v2.0",
      override: "https://harbor.example.com/api/v2.0",
    });
    assert.equal(r.url, "https://harbor.example.com/api/v2.0");
  });

  it("refuses a relative document base with no override", () => {
    caught(
      () => resolveBaseUrl({ declared: "/api/v2.0", override: undefined }),
      BaseUrlError,
    );
  });

  it("refuses when neither side offers anything", () => {
    assert.throws(() => resolveBaseUrl({ declared: undefined, override: undefined }), BaseUrlError);
  });

  it("refuses a relative override", () => {
    assert.throws(
      () => resolveBaseUrl({ declared: "/api", override: "harbor.example.com" }),
      BaseUrlError,
    );
  });

  it("says what both sides offered when it refuses", () => {
    const err = caught(
      () => resolveBaseUrl({ declared: "/api/v2.0", override: undefined }),
      BaseUrlError,
    );
    assert.match(err.message, /\/api\/v2\.0/);
    assert.match(err.message, /UPSTREAM_BASE_URL/);
  });
});
