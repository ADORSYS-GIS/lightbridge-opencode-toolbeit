import type { PluginInput, ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import { GitRepo } from "../src/git.js";
import { createCodeIndexPlugin } from "../src/opencode.js";
import type { CodeIndexStore } from "../src/store.js";
import { fakeRunner } from "./fake-git.js";

function pluginInput(): PluginInput {
  return {
    client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
    project: { id: "toolbelt" },
    directory: "/repo",
    worktree: "/repo"
  } as unknown as PluginInput;
}

/**
 * A store whose blob insert always fails. Paired with `brokenRepoState()` this
 * forces the indexer's read-failure path (warn) AND its fallback-write-failure
 * path (error) to fire in the same run — the cheapest way to exercise both
 * severities of the real (non-injected) logger in one pass.
 */
function failingStore(): CodeIndexStore {
  return {
    hasBlob: async () => false,
    insertBlob: async () => {
      throw new Error("disk full");
    },
    replaceManifest: async () => {}
  } as unknown as CodeIndexStore;
}

/** One indexable file whose blob is missing, so `GitRepo.readBlob` throws. */
function brokenRepoState() {
  return { branch: "main", tree: { "bad.ts": "badsha" }, blobs: {} };
}

function runTool(tool: ToolDefinition, args: Record<string, unknown>, worktree = "/repo") {
  const ctx = { worktree, abort: new AbortController().signal } as unknown as ToolContext;
  return (tool as unknown as { execute: (a: unknown, c: unknown) => Promise<string> }).execute(
    args,
    ctx
  );
}

/**
 * Build the plugin with NO injected `logger` (so the real, host-piped
 * `createOpenCodeLogger` from src/opencode.ts runs) but with an injected
 * `openStore`/`makeRepo` pair rigged to force a warn + error record, then
 * drive `index_refresh` to actually produce them.
 */
async function runIndexRefresh(input: PluginInput) {
  const hooks = await createCodeIndexPlugin({
    openStore: async () => failingStore(),
    makeRepo: () => new GitRepo(fakeRunner(brokenRepoState()))
  })(input, { dbPath: ":memory:" });
  const tools = hooks.tool as unknown as Record<string, ToolDefinition>;
  return runTool(tools.index_refresh, {});
}

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  // opencode-code-index is one of the eight plugins ADR-0014 newly covers (it
  // was never the ADR-0013 exception) — its own warn/error logs about the
  // indexer's failures must stay off the terminal just like every other
  // plugin's, and go only to the host via `client.app.log`.

  it("never mirrors a warn/error record to the console fallback", async () => {
    const input = pluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runIndexRefresh(input);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("still forwards the warn and error records to client.app.log at their true level", async () => {
    const input = pluginInput();

    await runIndexRefresh(input);

    const appLog = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    const calls = appLog.mock.calls.map((call) => ({
      message: call[0]?.body?.message,
      level: call[0]?.body?.level
    }));
    expect(calls).toContainEqual({ message: "code_index_blob_failed", level: "warn" });
    expect(calls).toContainEqual({ message: "code_index_fallback_write_failed", level: "error" });
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const input = pluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      await runIndexRefresh(input);
      expect(warn).toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
