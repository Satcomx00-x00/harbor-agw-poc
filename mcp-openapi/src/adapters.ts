/**
 * Adapter — one interface over two document dialects.
 *
 * OpenAPI 3 and Swagger 2.0 describe the same things differently: the base URL
 * lives in `servers[0].url` or is spread across `schemes`/`host`/`basePath`;
 * the request body is a `requestBody` object or a parameter with `in: body`;
 * a parameter's type sits under `schema` or directly on the parameter.
 *
 * The first version scattered `if (flavour === "swagger")` through the loader.
 * That works until a third dialect appears (OpenAPI 3.1 differs again on
 * nullable and on `exclusiveMinimum`), at which point every branch has to be
 * revisited and one will be missed.
 *
 * The Adapter pattern puts each dialect behind the same interface, so the
 * loader never asks which one it has, and support for another is a new class
 * rather than an edit to existing branches.
 * https://refactoring.guru/design-patterns/adapter
 */

import {
  asParameter,
  str,
  type JsonSchema,
  type RawDocument,
  type RawOperationObject,
  type RawParameter,
} from "./openapi.js";

/** What a body looks like once the dialect has been abstracted away. */
export interface BodySpec {
  schema: JsonSchema;
  required: boolean;
}

export interface SpecAdapter {
  readonly dialect: "openapi" | "swagger";

  /**
   * The base URL the document declares. May be a bare path: Swagger 2.0
   * documents routinely omit `host` while their `basePath` is authoritative.
   */
  declaredBaseUrl(doc: RawDocument): string | undefined;

  /** The JSON request body, if the operation takes one. */
  body(op: RawOperationObject, params: readonly RawParameter[]): BodySpec | undefined;

  /** The JSON Schema for a non-body parameter. */
  parameterSchema(param: RawParameter): JsonSchema;
}

/** Fields a Swagger 2.0 parameter carries inline instead of under `schema`. */
const INLINE_SCHEMA_KEYS = [
  "type", "format", "enum", "default", "items", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "uniqueItems", "multipleOf",
] as const;

export class OpenApi3Adapter implements SpecAdapter {
  readonly dialect = "openapi" as const;

  declaredBaseUrl(doc: RawDocument): string | undefined {
    return str(doc.servers?.[0]?.url);
  }

  body(op: RawOperationObject): BodySpec | undefined {
    const content = op.requestBody?.content;
    if (!content) return undefined;

    // Prefer application/json, then anything JSON-ish (application/
    // merge-patch+json, application/vnd.foo+json). Non-JSON media types are
    // left alone: this client only knows how to encode JSON, and guessing
    // would produce a request the upstream rejects for reasons that look
    // nothing like "wrong content type".
    const exact = content["application/json"]?.schema;
    if (exact) return { schema: exact, required: op.requestBody?.required === true };

    for (const [mediaType, value] of Object.entries(content)) {
      if (mediaType.includes("json") && value?.schema) {
        return { schema: value.schema, required: op.requestBody?.required === true };
      }
    }
    return undefined;
  }

  parameterSchema(param: RawParameter): JsonSchema {
    return param.schema ?? { type: "string" };
  }
}

export class Swagger2Adapter implements SpecAdapter {
  readonly dialect = "swagger" as const;

  declaredBaseUrl(doc: RawDocument): string | undefined {
    const basePath = str(doc.basePath) ?? "";
    const host = str(doc.host);
    if (!host) return basePath || undefined;
    const scheme = str(doc.schemes?.[0]) ?? "https";
    return `${scheme}://${host}${basePath}`;
  }

  body(_op: RawOperationObject, params: readonly RawParameter[]): BodySpec | undefined {
    // Swagger 2.0 models the body as a parameter. There is at most one.
    const bodyParam = params.find((p) => p.in === "body");
    if (!bodyParam?.schema) return undefined;
    return { schema: bodyParam.schema, required: bodyParam.required === true };
  }

  parameterSchema(param: RawParameter): JsonSchema {
    if (param.schema) return param.schema;

    // Rebuild a schema from the keywords Swagger 2.0 puts on the parameter
    // itself. Defaulting to `{ type: "string" }` instead would throw away
    // enums and formats the document took the trouble to state.
    const out: JsonSchema = {};
    const source = param as unknown as Record<string, unknown>;
    for (const key of INLINE_SCHEMA_KEYS) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    out.type ??= "string";
    return out;
  }
}

/**
 * Factory Method: pick the adapter from the document itself.
 * https://refactoring.guru/design-patterns/factory-method
 *
 * A document with neither marker is treated as OpenAPI 3, which is the shape
 * everything published since 2017 uses.
 */
export function selectAdapter(doc: RawDocument): SpecAdapter {
  return str(doc.swagger)?.startsWith("2") === true
    ? new Swagger2Adapter()
    : new OpenApi3Adapter();
}

/** Narrow a raw `parameters` array, dropping entries no dialect recognises. */
export function collectParameters(raw: readonly unknown[]): RawParameter[] {
  const out: RawParameter[] = [];
  for (const entry of raw) {
    const param = asParameter(entry);
    if (param) out.push(param);
  }
  return out;
}
