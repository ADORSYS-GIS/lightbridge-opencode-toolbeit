import type { PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

import { createOpencodeRatelimitPlugin } from "../src/opencode.js";

function pluginInput(): PluginInput {
  return {
    client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
    project: { id: "toolbelt" },
    directory: "/repo",
    worktree: "/repo"
  } as unknown as PluginInput;
}

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

interface FailFastProviderConfig {
  provider: {
    "test-provider": {
      options: {
        baseURL: string;
        meta: { rateLimit: { tiers: Array<Record<string, unknown>> } };
        fetch?: typeof fetch;
      };
    };
  };
}

/**
 * A provider config whose `meta.rateLimit` opts in with a single catch-all
 * `"error"` tier, so a 429 fails fast with a `ratelimit_failfast` warn on the
 * very first attempt — no waiting, no fake clock needed to drive the real
 * (non-injected) logger deterministically.
 */
function failFastConfig(): FailFastProviderConfig {
  return {
    provider: {
      "test-provider": {
        options: {
          baseURL: "https://api.test",
          meta: {
            rateLimit: {
              tiers: [{ maxResetSeconds: null, action: "error", maxWaitMs: 0, maxRetries: 0 }]
            }
          }
        }
      }
    }
  };
}

describe("ADR-0014: the plugin's own diagnostics never touch the terminal", () => {
  it("never mirrors a warn record to the console fallback", async () => {
    const input = pluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(res(429, { "x-ratelimit-reset": "5" }));

    const hooks = await createOpencodeRatelimitPlugin({ fetchImpl })(input, {});
    const config = failFastConfig();
    await hooks.config?.(config as never);
    const wrapped = config.provider["test-provider"].options.fetch as typeof fetch;
    const response = await wrapped("https://api.test");

    expect(response.status).toBe(429);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("still forwards the warn record to client.app.log at its true level", async () => {
    const input = pluginInput();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(res(429, { "x-ratelimit-reset": "5" }));

    const hooks = await createOpencodeRatelimitPlugin({ fetchImpl })(input, {});
    const config = failFastConfig();
    await hooks.config?.(config as never);
    const wrapped = config.provider["test-provider"].options.fetch as typeof fetch;
    await wrapped("https://api.test");

    const log = input.client.app.log as unknown as ReturnType<typeof vi.fn>;
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          service: "opencode-ratelimit-plugin",
          level: "warn",
          message: "ratelimit_failfast"
        })
      })
    );
    vi.restoreAllMocks();
  });

  it("restores the console mirror when VYMALO_PLUGIN_CONSOLE_LOG is set", async () => {
    const input = pluginInput();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previous = process.env.VYMALO_PLUGIN_CONSOLE_LOG;
    process.env.VYMALO_PLUGIN_CONSOLE_LOG = "1";

    try {
      const fetchImpl = vi.fn().mockResolvedValue(res(429, { "x-ratelimit-reset": "5" }));
      const hooks = await createOpencodeRatelimitPlugin({ fetchImpl })(input, {});
      const config = failFastConfig();
      await hooks.config?.(config as never);
      const wrapped = config.provider["test-provider"].options.fetch as typeof fetch;
      await wrapped("https://api.test");

      expect(warn).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.VYMALO_PLUGIN_CONSOLE_LOG;
      } else {
        process.env.VYMALO_PLUGIN_CONSOLE_LOG = previous;
      }
      warn.mockRestore();
    }
  });
});
