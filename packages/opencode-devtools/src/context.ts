import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { ToolContext } from "./tool-spec.js";
import type { ResolvedDevtoolsOptions } from "./types.js";

/**
 * Build the full tool execution context, applying DI overrides. Kept free of
 * any plugin-API (and `effect`) imports so the MCP server can reach it through
 * `./lib` without pulling the OpenCode runtime in.
 */
export function buildContext(
  options: ResolvedDevtoolsOptions,
  overrides?: Partial<Omit<ToolContext, "options">>
): ToolContext {
  return {
    options,
    now: overrides?.now ?? (() => new Date()),
    randomBytes: overrides?.randomBytes ?? ((size: number) => nodeRandomBytes(size)),
    fetchImpl: overrides?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  };
}
