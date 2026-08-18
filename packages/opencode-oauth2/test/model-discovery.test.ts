import { describe, expect, it } from "vitest";

import type { Logger } from "@vymalo/opencode-auth-core/lib";
import { fetchModels } from "../src/model-discovery.js";
import type { TokenSet } from "@vymalo/opencode-auth-core/lib";

const token: TokenSet = {
  accessToken: "test-token",
  tokenType: "Bearer",
  refreshToken: "test-refresh"
};

type Entry = { level: string; event: string; fields?: Record<string, unknown> };

function recordingLogger(entries: Entry[]): Logger {
  return {
    trace(event, fields) {
      entries.push({ level: "trace", event, fields });
    },
    debug(event, fields) {
      entries.push({ level: "debug", event, fields });
    },
    info(event, fields) {
      entries.push({ level: "info", event, fields });
    },
    warn(event, fields) {
      entries.push({ level: "warn", event, fields });
    },
    error(event, fields) {
      entries.push({ level: "error", event, fields });
    }
  };
}

describe("fetchModels error reporting", () => {
  it("logs the response body via the logger but does NOT include it in the thrown error message", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"insufficient_scope","detail":"missing access:foo"}', {
        status: 403,
        headers: { "Content-Type": "application/json" }
      })) as typeof fetch;
    const entries: Entry[] = [];

    await expect(
      fetchModels("https://api.example.com/v1", token, {
        fetchImpl,
        logger: recordingLogger(entries)
      })
    ).rejects.toThrow(
      /^model discovery failed \(403\) at https:\/\/api\.example\.com\/v1\/models$/
    );

    const bodyEntry = entries.find((e) => e.event === "model_discovery_error_body");
    expect(bodyEntry).toBeDefined();
    expect(bodyEntry?.fields?.bodyPreview).toContain("insufficient_scope");
    expect(bodyEntry?.fields?.status).toBe(403);
  });

  it("redacts userinfo and query parameters from the thrown error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;

    await expect(
      fetchModels("https://user:pass@api.example.com/v1?token=secret", token, { fetchImpl })
    ).rejects.toThrow(
      /^model discovery failed \(401\) at https:\/\/api\.example\.com\/v1\/models$/
    );
    await expect(
      fetchModels("https://user:pass@api.example.com/v1?token=secret", token, { fetchImpl })
    ).rejects.not.toThrow(/pass/);
    await expect(
      fetchModels("https://user:pass@api.example.com/v1?token=secret", token, { fetchImpl })
    ).rejects.not.toThrow(/secret/);
  });

  it("caps logged body preview at 500 chars even for very large bodies", async () => {
    const longBody = "X".repeat(5000);
    const fetchImpl = (async () => new Response(longBody, { status: 500 })) as typeof fetch;
    const entries: Entry[] = [];

    await expect(
      fetchModels("https://api.example.com/v1", token, {
        fetchImpl,
        logger: recordingLogger(entries)
      })
    ).rejects.toThrow(/^model discovery failed \(500\)/);

    const bodyEntry = entries.find((e) => e.event === "model_discovery_error_body");
    expect(bodyEntry).toBeDefined();
    const preview = bodyEntry?.fields?.bodyPreview as string;
    expect(preview.length).toBeLessThanOrEqual(500);
    expect(preview.startsWith("X")).toBe(true);
  });
});
