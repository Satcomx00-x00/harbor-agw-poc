/**
 * Two documents describing the same tiny API, one per dialect.
 *
 * Written by hand rather than trimmed from a real spec so that every field
 * present is one a test asserts on, and the dialect differences that actually
 * bit — the request body's home, the base URL's shape, where a parameter's type
 * lives — are visible side by side.
 */

export const openapi3 = {
  openapi: "3.0.3",
  info: { title: "Widgets", version: "1.2.3" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/widgets": {
      // Declared once for the path and inherited by every operation on it.
      // Documents do this and a loader that only reads operation-level
      // parameters loses them silently.
      parameters: [
        { name: "trace-id", in: "header", required: false, schema: { type: "string" } },
      ],
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        parameters: [
          { name: "page", in: "query", required: false, schema: { type: "integer" } },
          { name: "tag", in: "query", required: false, schema: { type: "array", items: { type: "string" } } },
        ],
      },
      post: {
        operationId: "createWidget",
        summary: "Create a widget",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
          },
        },
      },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [
          // Deliberately not marked required, to prove a path parameter is
          // treated as required regardless of what the document claims.
          { name: "id", in: "path", schema: { type: "string" } },
          { name: "session", in: "cookie", schema: { type: "string" } },
        ],
      },
    },
    "/health": { get: { summary: "Liveness" } },
  },
};

export const swagger2 = {
  swagger: "2.0",
  info: { title: "Widgets", version: "1.2.3" },
  // The Harbor shape: a placeholder host with an authoritative base path.
  host: "localhost",
  basePath: "/v1",
  schemes: ["http", "https"],
  paths: {
    "/widgets": {
      parameters: [{ name: "trace-id", in: "header", type: "string" }],
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        parameters: [
          // Swagger 2.0 puts type keywords on the parameter, not under `schema`.
          { name: "page", in: "query", type: "integer", format: "int32" },
          { name: "sort", in: "query", type: "string", enum: ["asc", "desc"] },
        ],
      },
      post: {
        operationId: "createWidget",
        parameters: [
          // And the body is a parameter, not a requestBody.
          {
            name: "widget",
            in: "body",
            required: true,
            schema: { type: "object", properties: { name: { type: "string" } } },
          },
          { name: "avatar", in: "formData", type: "file" },
        ],
      },
    },
    "/widgets/{id}": {
      get: {
        operationId: "getWidget",
        parameters: [{ name: "id", in: "path", type: "string" }],
      },
    },
    "/health": { get: { summary: "Liveness" } },
  },
};

/** A document whose base is a bare path, as Harbor's is once host is dropped. */
export const swagger2NoHost = { ...swagger2, host: undefined };
