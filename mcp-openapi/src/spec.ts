/**
 * Loading the OpenAPI document, and turning it into the operations this server
 * exposes.
 *
 * The client is built here, from the document, at start-up. There is no
 * generated per-service code and nothing hand-written about any particular API:
 * point the server at a different `openapi.json` and it becomes a different
 * server. That is what makes it a template rather than a starting point to
 * copy.
 *
 * (`openapi-typescript` is in devDependencies for the other half of that story:
 * when the target *is* known ahead of time, `npm run generate:types` emits
 * compile-time types for it. It plays no part at runtime, because a document
 * fetched from a URL cannot be typed at build time.)
 */

import $RefParser from "@apidevtools/json-schema-ref-parser";
import { readFile } from "node:fs/promises";
import type { Candidate } from "./allowlist.js";

const HTTP_METHODS = [
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
] as const;

export type JsonSchema = Record<string, unknown>;

export interface ParamSpec {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: JsonSchema;
  description: string | undefined;
}

export interface Operation {
  /** MCP tool name. Unique across the server. */
  toolName: string;
  method: string;
  path: string;
  operationId: string | undefined;
  summary: string | undefined;
  description: string | undefined;
  params: ParamSpec[];
  /** JSON body schema, when the operation takes one. */
  bodySchema: JsonSchema | undefined;
  bodyRequired: boolean;
}

export interface LoadedSpec {
  title: string;
  version: string;
  /** "openapi" (3.x) or "swagger" (2.0). */
  flavour: "openapi" | "swagger";
  /**
   * Base URL the document declares, which may be relative.
   *
   * OpenAPI 3 puts it in `servers[0].url`. Swagger 2.0 splits it across
   * `schemes`, `host` and `basePath`, and very often omits `host` entirely —
   * Harbor's document does — leaving nothing but a path. Hence the
   * "may be relative" and hence UPSTREAM_BASE_URL.
   */
  serverUrl: string | undefined;
  candidates: Candidate[];
  /** Indexed by `${METHOD} ${path}`. */
  operations: Map<string, RawOperation>;
}

interface RawOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  summary: string | undefined;
  description: string | undefined;
  parameters: unknown[];
  /** OpenAPI 3 only. Swagger 2.0 carries the body inside `parameters`. */
  requestBody: Record<string, unknown> | undefined;
  flavour: "openapi" | "swagger";
}

async function fetchText(source: string, timeoutMs: number): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(source, { signal: ac.signal });
      if (!res.ok) throw new Error(`GET ${source} returned HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }
  return readFile(source, "utf8");
}

/** Read a file or URL. Used for the allowlist too, which follows the same rule. */
export async function loadText(source: string, timeoutMs = 30000): Promise<string> {
  return fetchText(source, timeoutMs);
}

export async function loadSpec(source: string, timeoutMs = 30000): Promise<LoadedSpec> {
  const raw = await fetchText(source, timeoutMs);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${source} is not JSON. This server reads openapi.json; convert a YAML ` +
        `document first (npx js-yaml openapi.yaml > openapi.json).`,
    );
  }

  // Dereference $ref before anything else. OpenAPI documents lean on $ref
  // heavily, and a schema handed to a client with unresolved refs is a schema
  // the client cannot validate against. Resolving once here means everything
  // downstream — tool schemas, request validation — deals in plain JSON Schema.
  const doc = (await $RefParser.dereference(parsed as object)) as Record<string, any>;

  if (!doc.paths || typeof doc.paths !== "object") {
    throw new Error(`${source} has no "paths" object — is it really an OpenAPI document?`);
  }

  // Swagger 2.0 is still what a great many services publish, Harbor included,
  // so it is supported rather than rejected. The differences that matter here
  // are the base URL and where the request body lives; everything else this
  // server touches (parameters, JSON Schema) is close enough to be shared.
  const flavour: "openapi" | "swagger" =
    typeof doc.swagger === "string" && doc.swagger.startsWith("2") ? "swagger" : "openapi";

  const operations = new Map<string, RawOperation>();
  const candidates: Candidate[] = [];

  for (const [path, item] of Object.entries<any>(doc.paths)) {
    if (!item || typeof item !== "object") continue;

    // Parameters may be declared once for the whole path and inherited by each
    // operation. Missing this makes path parameters vanish from some specs.
    const shared: unknown[] = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;

      const own: unknown[] = Array.isArray(op.parameters) ? op.parameters : [];
      const key = `${method.toUpperCase()} ${path}`;

      operations.set(key, {
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === "string" ? op.operationId : undefined,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        description: typeof op.description === "string" ? op.description : undefined,
        parameters: [...shared, ...own],
        requestBody: op.requestBody,
        flavour,
      });

      candidates.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof op.operationId === "string" ? op.operationId : undefined,
      });
    }
  }

  let serverUrl: string | undefined;
  if (flavour === "swagger") {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : "https";
    const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
    serverUrl = typeof doc.host === "string" && doc.host
      ? `${scheme}://${doc.host}${basePath}`
      : basePath || undefined;
  } else {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    serverUrl =
      servers.length && typeof servers[0]?.url === "string" ? servers[0].url : undefined;
  }

  return {
    title: doc.info?.title ?? "openapi",
    version: doc.info?.version ?? "0.0.0",
    flavour,
    serverUrl,
    candidates,
    operations,
  };
}

/**
 * Tool names have to satisfy the MCP naming rules and be stable across
 * restarts, or a client's saved reference to a tool breaks on redeploy.
 *
 * operationId is preferred because it is the API's own stable identifier.
 * Falling back to method + path is what makes specs without operationIds
 * usable at all, which is a large fraction of real ones.
 */
export function toolNameFor(op: RawOperation, prefix?: string): string {
  const base =
    op.operationId ??
    `${op.method.toLowerCase()}_${op.path
      .replace(/\{([^}]+)\}/g, "by_$1")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")}`;

  const name = (prefix ? `${prefix}_${base}` : base)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);

  return name || "operation";
}

/** Build the callable Operation, including the JSON Schema for its arguments. */
export function buildOperation(raw: RawOperation, prefix?: string): Operation {
  const params: ParamSpec[] = [];

  let bodySchema: JsonSchema | undefined;
  let bodyRequired = false;

  for (const p of raw.parameters as any[]) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") continue;
    const where = p.in;

    // Swagger 2.0 models the request body as a parameter rather than a
    // separate requestBody object. There is at most one, by spec.
    if (where === "body") {
      if (p.schema) {
        bodySchema = p.schema as JsonSchema;
        bodyRequired = Boolean(p.required);
      }
      continue;
    }

    // formData and cookie parameters are dropped rather than half-supported:
    // formData needs multipart/urlencoded encoding this client does not do, and
    // there is no cookie jar here. Sending them as query parameters would look
    // like it worked and quietly hit the wrong thing.
    if (where !== "path" && where !== "query" && where !== "header") continue;

    params.push({
      name: p.name,
      in: where,
      // A path parameter is always required whatever the document claims;
      // the URL cannot be built without it.
      required: where === "path" ? true : Boolean(p.required),
      // Swagger 2.0 puts the type inline on the parameter instead of under a
      // `schema` key, so a v2 parameter with no `schema` still has usable
      // constraints worth passing through to the tool's input schema.
      schema:
        (p.schema as JsonSchema) ??
        (raw.flavour === "swagger" ? swagger2ParamSchema(p) : { type: "string" }),
      description: typeof p.description === "string" ? p.description : undefined,
    });
  }

  const content = raw.requestBody?.content as Record<string, any> | undefined;
  if (content) {
    const json =
      content["application/json"] ??
      Object.entries(content).find(([k]) => k.includes("json"))?.[1];
    if (json?.schema) {
      bodySchema = json.schema as JsonSchema;
      bodyRequired = Boolean(raw.requestBody?.required);
    }
  }

  return {
    toolName: toolNameFor(raw, prefix),
    method: raw.method,
    path: raw.path,
    operationId: raw.operationId,
    summary: raw.summary,
    description: raw.description,
    params,
    bodySchema,
    bodyRequired,
  };
}

/**
 * Rebuild a JSON Schema from a Swagger 2.0 parameter, whose type keywords sit
 * directly on the parameter object instead of under `schema`.
 */
function swagger2ParamSchema(p: Record<string, unknown>): JsonSchema {
  const out: JsonSchema = {};
  for (const k of [
    "type", "format", "enum", "default", "items", "minimum", "maximum",
    "minLength", "maxLength", "pattern", "uniqueItems", "multipleOf",
  ]) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  if (!out.type) out.type = "string";
  return out;
}

/**
 * The JSON Schema advertised for a tool's arguments.
 *
 * Passed through to MCP verbatim rather than converted to zod and back: OpenAPI
 * parameter schemas *are* JSON Schema, and MCP wants JSON Schema, so any
 * conversion in between can only lose fidelity — formats, enums, nested object
 * constraints. This is why the server uses the SDK's low-level API.
 */
export function inputSchemaFor(op: Operation): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.params) {
    properties[p.name] = {
      ...p.schema,
      description: [p.description, `(${p.in} parameter)`].filter(Boolean).join(" "),
    };
    if (p.required) required.push(p.name);
  }

  if (op.bodySchema) {
    properties.body = {
      ...op.bodySchema,
      description: "JSON request body",
    };
    if (op.bodyRequired) required.push("body");
  }

  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
