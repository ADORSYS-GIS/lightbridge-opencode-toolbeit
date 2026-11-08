import type { ToolEditor } from "@opencode/plugin/effect/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { Effect } from "effect";

import { GROUP_DESCRIPTIONS, selectTools } from "./catalog.js";
import { buildContext } from "./context.js";
import type { Logger } from "./logging.js";
import { type JsonSchema, toJsonSchema } from "./schema.js";
import type { NeutralResult, ToolContext } from "./tool-spec.js";
import type { ResolvedDevtoolsOptions } from "./types.js";

export interface ToolDeps {
  options: ResolvedDevtoolsOptions;
  logger: Logger;
  /** Inject the execution context (clock / randomness / fetch) for tests. */
  context?: Partial<Omit<ToolContext, "options">>;
}

/** The tool shape `ToolEditor.add` takes. */
type ToolInfo = Parameters<ToolEditor["add"]>[0];

/** The subset of a `ToolEditor` this plugin drives (lets tests pass a fake). */
export type DevtoolsToolEditor = Pick<ToolEditor, "add" | "namespace">;

/** `Tool.Result` as the v2 host consumes it from an `execute`. */
interface RenderedResult {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Render an adapter-neutral result into v2's `Tool.Result`. `content` is the
 * model-visible text; a `json` result's structured payload rides along as
 * `metadata` (a non-object payload is wrapped so `metadata` stays a record).
 */
export function renderResult(result: NeutralResult): RenderedResult {
  if (result.kind === "text") {
    return { content: result.text };
  }
  const { data } = result;
  const metadata =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { value: data };
  return { content: result.text, metadata };
}

/** Tool args arrive as `unknown` (raw JSON Schema carries no static type). */
function asArgs(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The exposed name is `<namespace>_<name>`; strip the group prefix off the catalog name. */
function localName(group: string, name: string): string {
  const prefix = `${group}_`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Build the v2 tool definitions for the enabled groups. Each is a thin adapter
 * over the shared catalog: run the handler with the execution context, render
 * the result, and surface a thrown error as a typed `Tool.Error`.
 *
 * Input is the catalog's own JSON Schema (`toJsonSchema`, the same emitter the
 * MCP server uses). v2 hands `execute` the decoded `unknown`; the handlers do
 * their own `reqString`/`reqNumber` coercion, as they always have.
 */
export function createDevtoolsToolInfos(deps: ToolDeps): ToolInfo[] {
  const ctx = buildContext(deps.options, deps.context);

  return selectTools(deps.options.groups).map((spec): ToolInfo => {
    const input: JsonSchema = toJsonSchema(spec.input);
    return {
      name: localName(spec.group, spec.name),
      description: spec.description,
      input,
      options: { namespace: spec.group },
      execute: (rawInput) =>
        Effect.tryPromise({
          try: async () => {
            deps.logger.trace("devtools_tool_invoked", { tool: spec.name, group: spec.group });
            const result = await spec.handler(asArgs(rawInput), ctx);
            deps.logger.trace("devtools_tool_completed", { tool: spec.name });
            return renderResult(result);
          },
          catch: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger.warn("devtools_tool_failed", { tool: spec.name, error: message });
            return new ToolError({ message });
          }
        })
    };
  });
}

/**
 * Register the enabled groups on a v2 `ToolEditor`: one `namespace` per group
 * (the host exposes a namespaced tool as `<namespace>_<name>`, which keeps the
 * public names — `math_eval`, `codec_base64`, … — identical to v1), then each
 * tool under its group.
 */
export function registerDevtoolsTools(editor: DevtoolsToolEditor, deps: ToolDeps): void {
  for (const group of new Set(deps.options.groups)) {
    editor.namespace({ name: group, description: GROUP_DESCRIPTIONS[group] });
  }
  for (const info of createDevtoolsToolInfos(deps)) {
    editor.add(info);
  }
}
