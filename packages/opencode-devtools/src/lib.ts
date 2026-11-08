// Library surface, shared with `@vymalo/opencode-devtools-mcp`.
//
// Deliberately free of any `effect` / `@opencode/plugin` *value* import: the MCP
// server is not an OpenCode plugin and does not install `effect` (a peer
// dependency of this package). The v2 plugin adapter (`createDevtoolsPlugin`,
// `registerDevtoolsTools`) lives behind the main entry; the MCP server reaches
// only the catalog, schema, options and execution-context pieces below.

export {
  DEFAULT_GROUPS,
  DEVTOOLS_TOOLS,
  GROUP_DESCRIPTIONS,
  type NeutralResult,
  selectTools,
  TOOL_GROUPS,
  type ToolContext,
  type ToolGroup,
  type ToolSpec
} from "./catalog.js";

export { buildContext } from "./context.js";

export { resolveOptions } from "./options.js";

export { type Field, type JsonInput, type JsonSchema, toJsonSchema } from "./schema.js";

export { json, optBool, optString, reqNumber, reqString, text } from "./tool-spec.js";

export type { LogFields, Logger, LogLevel } from "./logging.js";

export type {
  DevtoolsPluginOptions,
  HttpOptions,
  ResolvedDevtoolsOptions
} from "./types.js";
