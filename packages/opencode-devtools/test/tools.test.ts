import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { DEVTOOLS_TOOLS, GROUP_DESCRIPTIONS, TOOL_GROUPS } from "../src/catalog.js";
import type { Logger } from "../src/logging.js";
import { toJsonSchema } from "../src/schema.js";
import {
  createDevtoolsToolInfos,
  type DevtoolsToolEditor,
  registerDevtoolsTools,
  renderResult
} from "../src/tools.js";
import type { ResolvedDevtoolsOptions } from "../src/types.js";
import { options } from "./helpers.js";

function fakeLogger(): Logger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type Info = ReturnType<typeof createDevtoolsToolInfos>[number];

/** Look a tool up by its *exposed* name (`<namespace>_<name>`), like the host does. */
function byExposedName(infos: Info[]): Record<string, Info> {
  const out: Record<string, Info> = {};
  for (const info of infos) {
    out[`${info.options?.namespace}_${info.name}`] = info;
  }
  return out;
}

function tools(over: Partial<ResolvedDevtoolsOptions>, extra = {}) {
  return byExposedName(
    createDevtoolsToolInfos({ options: options(over), logger: fakeLogger(), ...extra })
  );
}

// The v2 `Tool.Context` is unused by these handlers; the tests never build one.
const toolCtx = {} as never;

async function exec(info: Info, args: unknown) {
  return Effect.runPromise(info.execute(args, toolCtx));
}

describe("createDevtoolsToolInfos", () => {
  it("registers only the enabled groups", () => {
    const names = Object.keys(tools({ groups: ["math"] }));
    expect(names).toContain("math_eval");
    expect(names.some((n) => n.startsWith("codec_"))).toBe(false);
    expect(names.some((n) => n.startsWith("http_"))).toBe(false);
  });

  it("includes http only when its group is enabled", () => {
    expect(Object.keys(tools({ groups: ["http"] }))).toEqual(["http_request", "http_graphql"]);
  });

  it("exposes every catalog tool under its unchanged public name", () => {
    const exposed = Object.keys(tools({ groups: [...TOOL_GROUPS] })).sort();
    expect(exposed).toEqual(DEVTOOLS_TOOLS.map((t) => t.name).sort());
  });

  it("hands the host the catalog's JSON Schema, not a zod shape", () => {
    const all = createDevtoolsToolInfos({
      options: options({ groups: [...TOOL_GROUPS] }),
      logger: fakeLogger()
    });
    expect(all).toHaveLength(DEVTOOLS_TOOLS.length);
    for (const info of all) {
      const spec = DEVTOOLS_TOOLS.find((t) => t.name === `${info.options?.namespace}_${info.name}`);
      expect(spec).toBeDefined();
      expect(info.description).toBe(spec?.description);
      expect(info.input).toEqual(toJsonSchema(spec?.input ?? {}));
      expect(info.input).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("renders a text result as content", async () => {
    const t = tools({ groups: ["codec"] });
    expect(await exec(t.codec_base64, { mode: "encode", input: "hi" })).toEqual({
      content: "aGk="
    });
  });

  it("renders a json result as content + metadata", async () => {
    const t = tools({ groups: ["math"] });
    const out = await exec(t.math_stats, { values: [2, 4] });
    expect(out.metadata?.mean).toBe(3);
    expect(typeof out.content).toBe("string");
  });

  it("fails with a typed Tool.Error and logs a warning on a handler error", async () => {
    const logger = fakeLogger();
    const t = byExposedName(
      createDevtoolsToolInfos({ options: options({ groups: ["math"] }), logger })
    );
    const exit = await Effect.runPromiseExit(t.math_eval.execute({ expression: 1 }, toolCtx));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("Tool.Error");
    expect(logger.warn).toHaveBeenCalledWith(
      "devtools_tool_failed",
      expect.objectContaining({ tool: "math_eval" })
    );
  });

  it("treats non-object input as empty args (handler then rejects it)", async () => {
    const t = tools({ groups: ["math"] });
    for (const bad of [undefined, null, "x", [1]]) {
      const exit = await Effect.runPromiseExit(t.math_eval.execute(bad, toolCtx));
      expect(exit._tag).toBe("Failure");
    }
  });

  it("stringifies a non-Error throw", async () => {
    const logger = fakeLogger();
    const spec = DEVTOOLS_TOOLS.find((s) => s.name === "math_eval");
    const original = spec?.handler;
    if (!spec || !original) throw new Error("catalog changed");
    (spec as { handler: unknown }).handler = () => {
      throw "boom";
    };
    try {
      const t = byExposedName(
        createDevtoolsToolInfos({ options: options({ groups: ["math"] }), logger })
      );
      await Effect.runPromiseExit(t.math_eval.execute({ expression: "1" }, toolCtx));
      expect(logger.warn).toHaveBeenCalledWith(
        "devtools_tool_failed",
        expect.objectContaining({ error: "boom" })
      );
    } finally {
      (spec as { handler: unknown }).handler = original;
    }
  });

  it("threads the injected context (clock/randomness) into handlers", async () => {
    const t = tools(
      { groups: ["crypto"] },
      { context: { randomBytes: (n: number) => Buffer.alloc(n, 0) } }
    );
    expect(await exec(t.crypto_random, { bytes: 4 })).toEqual({ content: "00000000" });
  });

  it("runs the http group over the injected fetch (SSRF guard intact)", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const t = tools({ groups: ["http"] }, { context: { fetchImpl } });
    const blocked = await Effect.runPromiseExit(
      t.http_request.execute({ method: "GET", url: "http://169.254.169.254/latest" }, toolCtx)
    );
    expect(blocked._tag).toBe("Failure");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("renderResult", () => {
  it("wraps non-record json payloads so metadata stays a record", () => {
    expect(renderResult({ kind: "json", text: "t", data: [1, 2] })).toEqual({
      content: "t",
      metadata: { value: [1, 2] }
    });
    expect(renderResult({ kind: "json", text: "t", data: 5 })).toEqual({
      content: "t",
      metadata: { value: 5 }
    });
    expect(renderResult({ kind: "json", text: "t", data: null })).toEqual({
      content: "t",
      metadata: { value: null }
    });
  });
});

describe("registerDevtoolsTools", () => {
  it("declares one namespace per enabled group, then adds each tool under it", () => {
    const calls: string[] = [];
    const namespaces: Array<{ name: string; description: string }> = [];
    const added: Array<{ name: string; options?: { namespace?: string } }> = [];
    const editor = {
      namespace: (ns: { name: string; description: string }) => {
        calls.push("namespace");
        namespaces.push(ns);
      },
      add: (tool: { name: string; options?: { namespace?: string } }) => {
        calls.push("add");
        added.push(tool);
      }
    } as unknown as DevtoolsToolEditor;

    registerDevtoolsTools(editor, {
      options: options({ groups: ["math", "codec"] }),
      logger: fakeLogger()
    });

    expect(namespaces).toEqual([
      { name: "math", description: GROUP_DESCRIPTIONS.math },
      { name: "codec", description: GROUP_DESCRIPTIONS.codec }
    ]);
    // Namespaces are declared before any tool that references them.
    expect(calls.indexOf("add")).toBeGreaterThan(calls.lastIndexOf("namespace"));
    expect(added.every((t) => t.options?.namespace)).toBe(true);
    // The group prefix lives in the namespace, not in the local name.
    expect(added.map((t) => t.name)).toContain("eval");
    expect(added.map((t) => t.name)).not.toContain("math_eval");
  });
});
