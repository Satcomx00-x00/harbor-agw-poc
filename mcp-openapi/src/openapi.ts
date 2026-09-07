/**
 * Structural types for the parts of an OpenAPI document this server reads, and
 * the guards that get from `unknown` to them.
 *
 * A parsed JSON document is `unknown`, and the honest way to walk it is to
 * check. The first version of this file did not exist: the document was typed
 * `any` and indexed freely, which is how two defects got in — a Swagger 2.0
 * body silently ignored, and a base path silently dropped. Neither was caught
 * by the compiler, because with `any` there is nothing to catch.
 *
 * These are deliberately *structural* and partial. The goal is not to model
 * OpenAPI — that is a large and unpleasant job — but to make every field this
 * server touches a field the compiler knows about.
 */

export type JsonSchema = Record<string, unknown>;

export const HTTP_METHODS = [
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/** Where a parameter travels. `body` and `formData` are Swagger 2.0 only. */
type ParameterLocation = "path" | "query" | "header" | "cookie" | "body" | "formData";

export interface RawParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  /** Swagger 2.0 puts type keywords directly on the parameter. */
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: JsonSchema;
}

interface RawRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: JsonSchema } | undefined>;
}

export interface RawOperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: RawRequestBody;
}

export type RawPathItem = Partial<Record<HttpMethod, RawOperationObject>> & {
  /** Parameters shared by every operation on the path. */
  parameters?: unknown[];
};

export interface RawDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, RawPathItem | undefined>;
  /** OpenAPI 3. */
  servers?: { url?: string }[];
  /** Swagger 2.0. */
  host?: string;
  basePath?: string;
  schemes?: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asDocument(v: unknown): RawDocument {
  if (!isRecord(v)) {
    throw new TypeError("the document is not a JSON object");
  }
  if (!isRecord(v.paths)) {
    throw new TypeError(
      'the document has no "paths" object — is it really an OpenAPI document?',
    );
  }
  return v;
}

const LOCATIONS: ReadonlySet<string> = new Set<ParameterLocation>([
  "path", "query", "header", "cookie", "body", "formData",
]);

/**
 * Narrow one entry of a `parameters` array.
 *
 * Returns undefined rather than throwing for anything unrecognised: a document
 * may legitimately carry vendor extensions here, and refusing to start over one
 * would make this server useless against half the specs in the wild.
 */
export function asParameter(v: unknown): RawParameter | undefined {
  if (!isRecord(v)) return undefined;
  const { name, in: location } = v;
  if (typeof name !== "string" || typeof location !== "string") return undefined;
  if (!LOCATIONS.has(location)) return undefined;
  return v as unknown as RawParameter;
}

export function isPathItem(v: unknown): v is RawPathItem {
  return isRecord(v);
}

export function isOperationObject(v: unknown): v is RawOperationObject {
  return isRecord(v);
}

/** Read a string field, or undefined when it is absent or the wrong type. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
