/**
 * Loading a document and turning it into the operations this server exposes.
 *
 * The client is built here, from the document, at start-up. There is no
 * generated per-service code and nothing hand-written about any particular API:
 * point the server at a different document and it becomes a different server.
 *
 * Dialect differences live in adapters.ts, so nothing below asks which kind of
 * document it has.
 */

import $RefParser from "@apidevtools/json-schema-ref-parser";
import { readFile } from "node:fs/promises";
import type { Candidate } from "./allowlist.js";
import {
  collectParameters,
  selectAdapter,
  type SpecAdapter,
} from "./adapters.js";
import {
  asDocument,
  HTTP_METHODS,
  isOperationObject,
  isPathItem,
  str,
  type JsonSchema,
  type RawDocument,
  type RawOperationObject,
  type RawParameter,
} from "./openapi.js";

export type { JsonSchema } from "./openapi.js";

/** A parameter this server knows how to send. */
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
  bodySchema: JsonSchema | undefined;
  bodyRequired: boolean;
}

export interface RawOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  summary: string | undefined;
  description: string | undefined;
  parameters: RawParameter[];
  object: RawOperationObject;
}

export interface LoadedSpec {
  title: string;
  version: string;
  adapter: SpecAdapter;
  /** What the document says the base URL is. May be relative. */
  declaredBaseUrl: string | undefined;
  candidates: Candidate[];
  /** Indexed by `${METHOD} ${path}`. */
  operations: Map<string, RawOperation>;
}

async function fetchText(source: string, timeoutMs: number): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    return readFile(source, "utf8");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(source, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${source} returned HTTP ${String(res.status)}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Read a file or URL. The allowlist follows the same rule. */
export async function loadText(source: string, timeoutMs = 30_000): Promise<string> {
  return fetchText(source, timeoutMs);
}

export function parseDocument(raw: string, source = "the document"): RawDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `${source} is not JSON. This server reads openapi.json; convert a YAML ` +
        "document first (npx js-yaml openapi.yaml > openapi.json).",
      { cause },
    );
  }

  try {
    return asDocument(parsed);
  } catch (cause) {
    throw new Error(`${source}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/** Walk a parsed, dereferenced document into the operations it declares. */
export function indexDocument(doc: RawDocument): LoadedSpec {
  const adapter = selectAdapter(doc);
  const operations = new Map<string, RawOperation>();
  const candidates: Candidate[] = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!isPathItem(item)) continue;

    // Parameters may be declared once for the whole path and inherited by each
    // operation. Missing this makes path parameters vanish from some documents.
    const shared = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of HTTP_METHODS) {
      const op: unknown = item[method];
      if (!isOperationObject(op)) continue;

      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const parameters = collectParameters([...shared, ...own]);
      const operationId = str(op.operationId);
      const upper = method.toUpperCase();

      operations.set(`${upper} ${path}`, {
        method: upper,
        path,
        operationId,
        summary: str(op.summary),
        description: str(op.description),
        parameters,
        object: op,
      });
      candidates.push({ method: upper, path, operationId });
    }
  }

  return {
    title: str(doc.info?.title) ?? "openapi",
    version: str(doc.info?.version) ?? "0.0.0",
    adapter,
    declaredBaseUrl: adapter.declaredBaseUrl(doc),
    candidates,
    operations,
  };
}

export async function loadSpec(source: string, timeoutMs = 30_000): Promise<LoadedSpec> {
  const doc = parseDocument(await fetchText(source, timeoutMs), source);

  // Dereference $ref before anything else. Documents lean on $ref heavily, and
  // a schema handed to a client with unresolved refs is one the client cannot
  // validate against. Resolving once here means everything downstream deals in
  // plain JSON Schema.
  const dereferenced = await $RefParser.dereference(doc as object);
  return indexDocument(asDocument(dereferenced));
}

/**
 * Tool names must satisfy MCP's naming rules and stay stable across restarts,
 * or a client's saved reference to a tool breaks on redeploy.
 *
 * operationId is preferred because it is the API's own stable identifier.
 * Falling back to method + path is what makes documents without operationIds
 * usable at all, which is a large fraction of real ones.
 */
export function toolNameFor(op: RawOperation, prefix?: string): string {
  const base =
    op.operationId ??
    `${op.method.toLowerCase()}_${op.path
      .replace(/\{([^}]+)\}/g, "by_$1")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")}`;

  const name = (prefix === undefined || prefix === "" ? base : `${prefix}_${base}`)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);

  return name === "" ? "operation" : name;
}

export function buildOperation(
  raw: RawOperation,
  adapter: SpecAdapter,
  prefix?: string,
): Operation {
  const params: ParamSpec[] = [];

  for (const param of raw.parameters) {
    // formData and cookie parameters are dropped rather than half-supported:
    // formData needs multipart/urlencoded encoding this client does not do, and
    // there is no cookie jar here. Sending either as a query parameter would
    // look like it worked and quietly hit the wrong thing. `body` is handled
    // by the adapter.
    if (param.in !== "path" && param.in !== "query" && param.in !== "header") continue;

    params.push({
      name: param.name,
      in: param.in,
      // A path parameter is always required whatever the document claims; the
      // URL cannot be built without it.
      required: param.in === "path" ? true : param.required === true,
      schema: adapter.parameterSchema(param),
      description: param.description,
    });
  }

  const body = adapter.body(raw.object, raw.parameters);

  return {
    toolName: toolNameFor(raw, prefix),
    method: raw.method,
    path: raw.path,
    operationId: raw.operationId,
    summary: raw.summary,
    description: raw.description,
    params,
    bodySchema: body?.schema,
    bodyRequired: body?.required ?? false,
  };
}

/**
 * The JSON Schema advertised for a tool's arguments.
 *
 * Passed to MCP verbatim rather than converted to Zod and back: OpenAPI
 * parameter schemas *are* JSON Schema, so any conversion in between can only
 * lose fidelity — formats, enums, nested object constraints. This is why the
 * server uses the SDK's low-level API.
 */
export function inputSchemaFor(op: Operation): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of op.params) {
    properties[param.name] = {
      ...param.schema,
      description: [param.description, `(${param.in} parameter)`]
        .filter((s) => s !== undefined && s !== "")
        .join(" "),
    };
    if (param.required) required.push(param.name);
  }

  if (op.bodySchema) {
    properties.body = { ...op.bodySchema, description: "JSON request body" };
    if (op.bodyRequired) required.push("body");
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
