/**
 * A tiny, neutral schema vocabulary for tool arguments. The tool catalog
 * (`catalog.ts`) is the single source of truth; each adapter turns these specs
 * into its own format:
 *   - the OpenCode v2 plugin hands `toJsonSchema`'s output straight to
 *     `ToolEditor.add({ input })` (v2 takes raw JSON Schema; see tools.ts),
 *   - the MCP server emits the same standard JSON Schema via `toJsonSchema`.
 *
 * Lifted verbatim from `@vymalo/opencode-browser` so the two tool-registering
 * plugins describe their surface the same way. Keeping the vocabulary small
 * avoids dragging a specific zod version across the package boundary.
 */

export type ToolGroup = "math" | "codec" | "crypto" | "datetime" | "convert" | "http";

export interface StringField {
  type: "string";
  description?: string;
  optional?: boolean;
  enum?: readonly string[];
}
export interface NumberField {
  type: "number";
  description?: string;
  optional?: boolean;
}
export interface BooleanField {
  type: "boolean";
  description?: string;
  optional?: boolean;
}
export interface ArrayField {
  type: "array";
  description?: string;
  optional?: boolean;
  items: Field;
}
export interface ObjectField {
  type: "object";
  description?: string;
  optional?: boolean;
  properties: Record<string, Field>;
}
/**
 * An open key→value map with arbitrary keys (e.g. HTTP headers, GraphQL
 * variables). Unlike `object`, it does NOT set `additionalProperties: false`,
 * so real keys aren't stripped/rejected by a validating client. `valueType`
 * picks the value schema (`string` for headers, `any` for variables).
 */
export interface RecordField {
  type: "record";
  description?: string;
  optional?: boolean;
  valueType?: "string" | "any";
}
export type Field =
  | StringField
  | NumberField
  | BooleanField
  | ArrayField
  | ObjectField
  | RecordField;

/** Top-level argument map for a tool. */
export type JsonInput = Record<string, Field>;

// A type alias, not an interface: v2's `Tool.ValueSchema` accepts effect's
// `JsonSchema` (`{ [x: string]: unknown }`), and only a type alias carries the
// implicit index signature that makes this assignable to it.
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

function fieldToJsonSchema(field: Field): Record<string, unknown> {
  const out: Record<string, unknown> = { type: field.type };
  if (field.description) {
    out.description = field.description;
  }
  if (field.type === "string" && field.enum) {
    out.enum = [...field.enum];
  }
  if (field.type === "array") {
    out.items = fieldToJsonSchema(field.items);
  }
  if (field.type === "record") {
    out.type = "object";
    out.additionalProperties = field.valueType === "any" ? true : { type: "string" };
  }
  if (field.type === "object") {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(field.properties)) {
      properties[key] = fieldToJsonSchema(value);
      if (!value.optional) {
        required.push(key);
      }
    }
    out.properties = properties;
    out.required = required;
    out.additionalProperties = false;
  }
  return out;
}

/** Convert a tool's input spec to a standard JSON Schema object (for MCP). */
export function toJsonSchema(input: JsonInput): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(input)) {
    properties[key] = fieldToJsonSchema(field);
    if (!field.optional) {
      required.push(key);
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}
