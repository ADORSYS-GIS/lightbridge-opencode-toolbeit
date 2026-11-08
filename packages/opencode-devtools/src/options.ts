import { DEFAULT_GROUPS, TOOL_GROUPS } from "./catalog.js";
import type { ToolGroup } from "./schema.js";
import type { DevtoolsPluginOptions, ResolvedDevtoolsOptions } from "./types.js";

const DEFAULTS = {
  httpTimeoutMs: 30_000
} as const;

function resolveGroups(raw: unknown): ToolGroup[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_GROUPS];
  }
  const valid = raw.filter((g): g is ToolGroup => TOOL_GROUPS.includes(g as ToolGroup));
  // An explicit but empty/invalid list falls back to the defaults rather than
  // registering nothing — matches the browser plugin's behaviour.
  return valid.length > 0 ? Array.from(new Set(valid)) : [...DEFAULT_GROUPS];
}

/**
 * Resolve raw plugin options (v2's `ctx.options`, or the MCP server's env-built
 * object) into fully-defaulted options. Lives apart from `opencode.ts` so the
 * MCP server can import it via `./lib` without loading the plugin runtime.
 */
export function resolveOptions(
  raw: Readonly<Record<string, unknown>> | undefined
): ResolvedDevtoolsOptions {
  const opts = (raw ?? {}) as DevtoolsPluginOptions;
  return {
    enabled: opts.enabled !== false,
    groups: resolveGroups(opts.groups),
    http: {
      allowPrivateNetwork: opts.http?.allowPrivateNetwork === true,
      timeoutMs:
        typeof opts.http?.timeoutMs === "number" && opts.http.timeoutMs > 0
          ? opts.http.timeoutMs
          : DEFAULTS.httpTimeoutMs
    }
  };
}
