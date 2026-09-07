/**
 * Turning a document plus an allowlist into the fixed set of tools this process
 * serves.
 *
 * Extracted from the boot sequence so it can be asserted without starting an
 * HTTP server: "this document and this allowlist produce exactly these tools"
 * is the single most important property of this component, and it should be a
 * unit test rather than something observed in a log.
 */

import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";

// ajv and ajv-formats are CommonJS whose .d.ts files use `export default`,
// while the emitted files set `module.exports` to the callable itself. Under
// module: nodenext TypeScript resolves a default import to the namespace, which
// is not constructable, and the build fails on packages that work perfectly at
// runtime. createRequire loads them the way they were built; the
// `typeof import(...).default` casts keep the real types.
const require = createRequire(import.meta.url);
type Ajv2020Type = InstanceType<typeof import("ajv/dist/2020.js").default>;
const Ajv2020 = require("ajv/dist/2020.js") as unknown as typeof import("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats") as unknown as typeof import("ajv-formats").default;
import { applyAllowlist, parseAllowlist, type Rule } from "./allowlist.js";
import { buildOperation, type JsonSchema, type LoadedSpec, type Operation } from "./spec.js";
import { inputSchemaFor } from "./spec.js";

export interface Tool {
  operation: Operation;
  schema: JsonSchema;
  validate: ValidateFunction;
}

export interface Registry {
  tools: Map<string, Tool>;
  /** Operations dropped by a `!` rule, for the start-up log. */
  excluded: { method: string; path: string; rule: Rule }[];
}

/** A rule that matched nothing, or a name two operations both want. */
export class RegistryError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[]) {
    super([message, ...details].join("\n"));
    this.name = "RegistryError";
    this.details = details;
  }
}

function createAjv(): Ajv2020Type {
  // Draft 2020-12: OpenAPI 3.1 schemas are 2020-12, and the plain Ajv export
  // only knows draft-07. Compiling a 2020-12 schema with the wrong dialect
  // fails on `prefixItems` and `$dynamicRef` in ways that read like a broken
  // document rather than a wrong validator.
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // Arguments arrive as JSON over MCP, so a numeric path parameter shows up
    // as whatever the client sent. Coercing is what makes {"page": "2"} work.
    coerceTypes: true,
  });
  addFormats(ajv);
  return ajv;
}

export function buildRegistry(
  spec: LoadedSpec,
  allowlistText: string,
  toolPrefix?: string,
): Registry {
  const rules = parseAllowlist(allowlistText);
  const selection = applyAllowlist(rules, spec.candidates);

  // A rule that matches nothing is almost always a typo, and the damage is a
  // tool that silently does not exist. Refusing to start is louder than a log
  // line nobody reads.
  if (selection.deadRules.length > 0) {
    throw new RegistryError(
      "allowlist rules that matched no operation in the document:",
      [
        ...selection.deadRules.map((r) => `  line ${String(r.line)}: ${r.raw}`),
        "",
        "Every include rule must match at least one operation. Check the method,",
        "and remember templated segments are matched literally: /users/{id}, not /users/*.",
      ],
    );
  }

  if (selection.selected.length === 0) {
    throw new RegistryError("the allowlist selected no operations — nothing to serve", []);
  }

  const ajv = createAjv();
  const tools = new Map<string, Tool>();

  for (const candidate of selection.selected) {
    const raw = spec.operations.get(`${candidate.method} ${candidate.path}`);
    if (!raw) continue;

    const operation = buildOperation(raw, spec.adapter, toolPrefix);
    const existing = tools.get(operation.toolName);
    if (existing) {
      // Two operations collapsing to one name would make one unreachable, and
      // which one wins would depend on iteration order.
      throw new RegistryError(`duplicate tool name "${operation.toolName}"`, [
        `  ${existing.operation.method} ${existing.operation.path}`,
        `  ${operation.method} ${operation.path}`,
        "",
        "Set MCP_TOOL_PREFIX, or give the operations distinct operationIds.",
      ]);
    }

    const schema = inputSchemaFor(operation);
    tools.set(operation.toolName, { operation, schema, validate: ajv.compile(schema) });
  }

  return {
    tools,
    excluded: selection.excluded.map((e) => ({
      method: e.candidate.method,
      path: e.candidate.path,
      rule: e.rule,
    })),
  };
}
