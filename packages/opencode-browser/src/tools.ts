import { mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Plugin } from "@opencode/plugin/effect";
import { Data, Effect } from "effect";

import type { AgentEndpoint } from "./broker.js";
import { BROWSER_TOOLS, type NeutralResult } from "./catalog.js";
import type { Logger } from "./logging.js";
import { toJsonSchema } from "./schema.js";
import type { ResolvedBrowserOptions, ScreenshotResult } from "./types.js";

/** The tool-registration editor the host hands to a `tool.transform` callback. */
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];

/** One tool definition, exactly as `ToolEditor.add` takes it. */
export type BrowserToolInfo = Parameters<ToolEditor["add"]>[0];

/**
 * Failure channel of a v2 tool. The host's `Tool.Error` is a `Schema.Class`
 * tagged `"Tool.Error"`, but `@opencode/plugin/effect` does not re-export it,
 * so this is a structurally identical tagged error built from `effect` itself
 * (the host's own copy, per the package README).
 */
class BrowserToolError extends Data.TaggedError("Tool.Error")<{
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}> {}

/** How a tool reaches the bridge — the endpoint's `send` (host or guest). */
export type SendFn = AgentEndpoint["send"];

/** Where the screenshot tool gets its disk-write behavior; swappable in tests. */
export type SaveScreenshot = (input: {
  group: string;
  worktree: string;
  shot: ScreenshotResult;
}) => Promise<string>;

export interface ToolDeps {
  send: SendFn;
  options: ResolvedBrowserOptions;
  logger: Logger;
  /**
   * Directory a relative `screenshotDir` resolves against. v1 read it off the
   * per-call `ctx.worktree`; v2's tool context carries none, so the plugin
   * passes its own `location.project.directory`.
   */
  worktree: string;
  saveScreenshot?: SaveScreenshot;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Replace anything that isn't filesystem-friendly so a group name is path-safe.
 * Dots are intentionally NOT allowed — otherwise a group like `..` or `a/../b`
 * could traverse out of the screenshot directory.
 */
function slugifyGroup(group: string): string {
  const slug = group.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "default";
}

/** Build the real disk-writer bound to the resolved screenshot directory. */
function makeSaveScreenshot(options: ResolvedBrowserOptions): SaveScreenshot {
  return async ({ group, worktree, shot }) => {
    const base = isAbsolute(options.screenshotDir)
      ? options.screenshotDir
      : join(worktree, options.screenshotDir);
    const dir = join(base, slugifyGroup(group));
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const finalPath = join(dir, `${stamp}.png`);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, Buffer.from(shot.base64, "base64"), { mode: 0o600 });
    await rename(tmpPath, finalPath);
    return finalPath;
  };
}

interface RenderDeps {
  group: string;
  worktree: string;
  saveScreenshot: SaveScreenshot;
  logger: Logger;
}

/** The slice of `Tool.Result` these tools produce. */
interface RenderedResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Render an adapter-neutral result into OpenCode's text-only `Tool.Result`. The
 * model-visible text goes in `content`; `output` is the typed-output channel,
 * which these tools (no output schema) leave unset.
 */
async function renderOpenCode(result: NeutralResult, deps: RenderDeps): Promise<RenderedResult> {
  if (result.kind === "text") {
    return { content: result.text };
  }
  if (result.kind === "json") {
    return { content: result.text, metadata: asRecord(result.data) };
  }
  // image → write the PNG to disk and hand back the path (tool output is text).
  const path = await deps.saveScreenshot({
    group: deps.group,
    worktree: deps.worktree,
    shot: {
      base64: result.base64,
      width: result.width,
      height: result.height,
      partial: result.partial
    }
  });
  deps.logger.info("browser_screenshot_saved", { group: deps.group, path });
  const partialNote = result.partial
    ? " Note: only the viewport was captured — this executor can't capture beyond it."
    : "";
  return {
    content: `Saved screenshot to ${path} (${result.width}×${result.height}). Use the read tool to view it.${partialNote}`,
    metadata: {
      path,
      width: result.width,
      height: result.height,
      partial: Boolean(result.partial),
      group: deps.group
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the `browser_*` tool definitions registered through `tool.transform`,
 * filtered to the enabled groups, keyed by tool name. Each tool is a thin
 * adapter over the shared catalog: forward to the bridge, render the neutral
 * result. `input` is the catalog's own JSON Schema (`toJsonSchema`) — the very
 * document the MCP server emits.
 *
 * `send` runs inside `Effect.tryPromise`, whose `AbortSignal` fires when the
 * host interrupts the tool fiber. That signal is what v1 received as
 * `ctx.abort`, and it still drives the broker's `cancel` frame (the teardown of
 * a human-in-the-loop `browser_request_feedback` overlay).
 */
export function createBrowserTools(deps: ToolDeps): Record<string, BrowserToolInfo> {
  const enabled = new Set(deps.options.groups);
  const saveScreenshot = deps.saveScreenshot ?? makeSaveScreenshot(deps.options);
  const tools: Record<string, BrowserToolInfo> = {};

  for (const spec of BROWSER_TOOLS) {
    if (!enabled.has(spec.group)) {
      continue;
    }
    tools[spec.name] = {
      name: spec.name,
      description: spec.description,
      input: { ...toJsonSchema(spec.input) },
      execute: (input) =>
        Effect.tryPromise({
          try: async (signal) => {
            const args = asRecord(input);
            const group = typeof args.group === "string" ? args.group : "";
            const target = typeof args.target === "string" ? args.target : undefined;
            const params = spec.params ? spec.params(args) : args;
            deps.logger.trace("browser_tool_invoked", {
              tool: spec.name,
              action: spec.action,
              group,
              target
            });
            const data = await deps.send(
              spec.action,
              group,
              params,
              signal,
              target,
              spec.timeoutMs
            );
            deps.logger.trace("browser_tool_completed", { tool: spec.name, group });
            const result: NeutralResult = spec.result
              ? spec.result(data, args)
              : { kind: "text", text: `${spec.name} ok` };
            return renderOpenCode(result, {
              group,
              worktree: deps.worktree,
              saveScreenshot,
              logger: deps.logger
            });
          },
          catch: (err) => new BrowserToolError({ message: errorMessage(err) })
        })
    };
  }

  return tools;
}
