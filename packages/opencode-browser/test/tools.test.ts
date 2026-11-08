import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOLS } from "../src/catalog.js";
import type { Logger } from "../src/logging.js";
import { toJsonSchema } from "../src/schema.js";
import { createBrowserTools, type SendFn, type ToolDeps } from "../src/tools.js";
import type { ResolvedBrowserOptions } from "../src/types.js";

const noopLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function baseOptions(overrides: Partial<ResolvedBrowserOptions> = {}): ResolvedBrowserOptions {
  return {
    enabled: true,
    host: "127.0.0.1",
    port: 4517,
    token: "secret",
    executor: "auto",
    groups: ["page", "control", "debug", "interactive"],
    timeoutMs: 30_000,
    screenshotDir: ".opencode/browser",
    ...overrides
  };
}

/** Fake endpoint send() spy. */
function fakeSend(result: unknown = {}) {
  return vi.fn().mockResolvedValue(result) as unknown as SendFn & ReturnType<typeof vi.fn>;
}

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    send: fakeSend(),
    options: baseOptions(),
    logger: noopLogger,
    worktree: "/tmp",
    ...over
  };
}

type Tools = ReturnType<typeof createBrowserTools>;
interface Result {
  content?: string;
  metadata?: Record<string, unknown>;
}

/** Run a tool's Effect the way the host does, optionally with an interrupt signal. */
function exec(
  tools: Tools,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Result> {
  const info = tools[name];
  const effect = info.execute(args, {} as Parameters<typeof info.execute>[1]);
  return Effect.runPromise(effect as Effect.Effect<Result, unknown>, { signal });
}

const text = (res: Result) => res.content ?? "";

describe("tool registration shape", () => {
  const tools = createBrowserTools(deps());

  it("exposes every catalog tool, keyed and named identically", () => {
    expect(Object.keys(tools)).toHaveLength(BROWSER_TOOLS.length);
    expect(BROWSER_TOOLS).toHaveLength(34);
    for (const spec of BROWSER_TOOLS) {
      expect(tools[spec.name]?.name).toBe(spec.name);
      expect(tools[spec.name]?.description).toBe(spec.description);
    }
  });

  it("emits the catalog's own JSON Schema (the document the MCP server emits) as input", () => {
    for (const spec of BROWSER_TOOLS) {
      expect(tools[spec.name]?.input).toEqual(toJsonSchema(spec.input));
    }
  });

  it("requires group on browser_open", () => {
    const schema = tools.browser_open.input as { required: string[] };
    expect(schema.required).toContain("group");
  });

  it("enumerates the mouse buttons on browser_click", () => {
    const schema = tools.browser_click.input as {
      properties: { button: { enum: string[] } };
    };
    expect(schema.properties.button.enum).toContain("right");
    expect(schema.properties.button.enum).not.toContain("sideways");
  });

  it("describes the fields array on browser_fill, with value required per item", () => {
    const schema = tools.browser_fill.input as {
      properties: { fields: { type: string; items: { required: string[] } } };
    };
    expect(schema.properties.fields.type).toBe("array");
    expect(schema.properties.fields.items.required).toContain("value");
  });

  it("filters tools by enabled groups", () => {
    const pageOnly = createBrowserTools(deps({ options: baseOptions({ groups: ["page"] }) }));
    const names = Object.keys(pageOnly);
    expect(names).toContain("browser_screenshot");
    expect(names).toContain("browser_snapshot");
    expect(names).not.toContain("browser_click"); // control group excluded
    expect(names).not.toContain("browser_open");
  });

  it("spot-checks representative tools from each group", () => {
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "browser_open",
        "browser_click",
        "browser_back",
        "browser_hover",
        "browser_get_html",
        "browser_query",
        "browser_eval",
        "browser_console",
        "browser_cookies"
      ])
    );
  });
});

describe("tool → bridge action mapping", () => {
  it("maps browser_open to the open action (with target)", async () => {
    const send = fakeSend({ title: "Example", url: "https://example.com" });
    const tools = createBrowserTools(deps({ send }));
    const res = await exec(tools, "browser_open", {
      group: "research",
      url: "https://example.com",
      target: "work-chrome"
    });
    expect(send).toHaveBeenCalledWith(
      "open",
      "research",
      expect.objectContaining({ url: "https://example.com" }),
      expect.any(AbortSignal),
      "work-chrome",
      undefined
    );
    expect(text(res)).toContain("research");
  });

  it("maps browser_click target params through", async () => {
    const send = fakeSend();
    const tools = createBrowserTools(deps({ send }));
    await exec(tools, "browser_click", { group: "g", ref: "e7" });
    expect(send).toHaveBeenCalledWith(
      "click",
      "g",
      expect.objectContaining({ ref: "e7" }),
      expect.anything(),
      undefined,
      undefined
    );
  });

  it("returns page text as the model-visible content for browser_get_text", async () => {
    const send = fakeSend({ text: "hello world" });
    const tools = createBrowserTools(deps({ send }));
    expect(await exec(tools, "browser_get_text", { group: "g" })).toEqual({
      content: "hello world"
    });
  });

  it("returns structured data as metadata alongside the content", async () => {
    const send = fakeSend({ title: "Example", url: "https://example.com" });
    const tools = createBrowserTools(deps({ send }));
    const res = await exec(tools, "browser_open", { group: "g", url: "https://example.com" });
    expect(res.metadata).toBeTypeOf("object");
  });

  it("falls back to a short ack when the spec defines no result mapper", async () => {
    const tools = createBrowserTools(deps());
    const res = await exec(tools, "browser_back", { group: "g" });
    expect(text(res)).toBeTruthy();
  });

  it("treats non-string group/target args as absent", async () => {
    const send = fakeSend();
    const tools = createBrowserTools(deps({ send }));
    await exec(tools, "browser_click", { group: 7, target: 9, ref: "e1" });
    expect(send).toHaveBeenCalledWith(
      "click",
      "",
      expect.anything(),
      expect.anything(),
      undefined,
      undefined
    );
  });

  it("treats non-object input as empty args", async () => {
    const send = fakeSend();
    const tools = createBrowserTools(deps({ send }));
    const info = tools.browser_back;
    await Effect.runPromise(
      info.execute(null, {} as Parameters<typeof info.execute>[1]) as Effect.Effect<Result, unknown>
    );
    expect(send).toHaveBeenCalledWith(
      "back",
      "",
      expect.anything(),
      expect.anything(),
      undefined,
      undefined
    );
  });
});

describe("failure and cancellation", () => {
  it("fails the Effect with a Tool.Error-tagged error carrying the bridge message", async () => {
    const send = vi.fn().mockRejectedValue(new Error("no extension connected"));
    const tools = createBrowserTools(deps({ send: send as unknown as SendFn }));
    const info = tools.browser_back;

    const exit = await Effect.runPromiseExit(
      info.execute({ group: "g" }, {} as Parameters<typeof info.execute>[1]) as Effect.Effect<
        Result,
        { _tag: string; message: string }
      >
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
    expect(failure).toContain("Tool.Error");
    expect(failure).toContain("no extension connected");
  });

  it("stringifies a non-Error rejection", async () => {
    const send = vi.fn().mockRejectedValue("plain string");
    const tools = createBrowserTools(deps({ send: send as unknown as SendFn }));
    await expect(exec(tools, "browser_back", { group: "g" })).rejects.toMatchObject({
      message: "plain string"
    });
  });

  it("hands send() a signal that fires when the host interrupts the tool fiber", async () => {
    let seen: AbortSignal | undefined;
    const send = vi.fn((_a, _g, _p, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<unknown>(() => {}); // blocks, like a human-in-the-loop prompt
    }) as unknown as SendFn;
    const tools = createBrowserTools(deps({ send }));
    const controller = new AbortController();

    const running = exec(
      tools,
      "browser_request_feedback",
      { group: "g", mode: "confirm" },
      controller.signal
    );
    running.catch(() => {});
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);

    controller.abort();

    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
  });
});

describe("browser_screenshot disk write", () => {
  it("writes the PNG and returns its path as text content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocb-shot-"));
    const png = Buffer.from("fake-png-bytes");
    const send = fakeSend({ base64: png.toString("base64"), width: 1280, height: 800 });
    const tools = createBrowserTools(
      deps({
        send,
        // absolute screenshotDir → written there directly
        options: baseOptions({ screenshotDir: dir })
      })
    );

    const res = await exec(tools, "browser_screenshot", { group: "my group" });
    expect(text(res)).toMatch(/1280×800/);
    expect(res.metadata).toMatchObject({ width: 1280, height: 800, partial: false });

    // group "my group" is slugified to "my-group"
    const files = await readdir(join(dir, "my-group"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);
    const written = await readFile(join(dir, "my-group", files[0]));
    expect(written.equals(png)).toBe(true);
  });

  it("resolves a relative screenshotDir against the plugin's project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocb-root-"));
    const send = fakeSend({ base64: Buffer.from("x").toString("base64"), width: 1, height: 1 });
    const tools = createBrowserTools(
      deps({ send, worktree: root, options: baseOptions({ screenshotDir: "shots" }) })
    );

    await exec(tools, "browser_screenshot", { group: "g" });

    expect(await readdir(join(root, "shots", "g"))).toHaveLength(1);
  });

  it("notes a viewport-only capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocb-shot-"));
    const send = fakeSend({ base64: "eA==", width: 2, height: 2, partial: true });
    const tools = createBrowserTools(deps({ send, options: baseOptions({ screenshotDir: dir }) }));
    const res = await exec(tools, "browser_screenshot", { group: "g", fullPage: true });
    expect(text(res)).toMatch(/only the viewport/);
    expect(res.metadata?.partial).toBe(true);
  });

  it("uses an injected screenshot writer when given", async () => {
    const saveScreenshot = vi.fn().mockResolvedValue("/x/y.png");
    const send = fakeSend({ base64: "eA==", width: 3, height: 4 });
    const tools = createBrowserTools(deps({ send, saveScreenshot, worktree: "/proj" }));
    const res = await exec(tools, "browser_screenshot", { group: "g" });
    expect(saveScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ group: "g", worktree: "/proj" })
    );
    expect(text(res)).toContain("/x/y.png");
  });
});

describe("browser_request_feedback (interactive group)", () => {
  const interactive = (result: unknown) =>
    createBrowserTools(
      deps({ send: fakeSend(result), options: baseOptions({ groups: ["interactive"] }) })
    );

  it("is gated behind the opt-in interactive group", () => {
    const off = createBrowserTools(
      deps({ options: baseOptions({ groups: ["page", "control", "debug"] }) })
    );
    expect(Object.keys(off)).not.toContain("browser_request_feedback");

    const on = createBrowserTools(
      deps({ options: baseOptions({ groups: ["page", "control", "interactive"] }) })
    );
    expect(Object.keys(on)).toContain("browser_request_feedback");
  });

  it("sends the request_feedback action with a long per-command timeout", async () => {
    const send = fakeSend({ responded: true, annotations: [{ kind: "confirm", value: true }] });
    const tools = createBrowserTools(
      deps({ send, options: baseOptions({ groups: ["interactive"] }) })
    );
    await exec(tools, "browser_request_feedback", { group: "g", mode: "confirm", prompt: "ok?" });
    expect(send).toHaveBeenCalledWith(
      "request_feedback",
      "g",
      expect.objectContaining({ mode: "confirm", prompt: "ok?", timeoutMs: 120_000 }),
      expect.anything(),
      undefined,
      300_000
    );
  });

  it("clamps a user timeout to the overlay ceiling", async () => {
    const send = fakeSend({ responded: true, annotations: [] });
    const tools = createBrowserTools(
      deps({ send, options: baseOptions({ groups: ["interactive"] }) })
    );
    await exec(tools, "browser_request_feedback", {
      group: "g",
      mode: "confirm",
      timeoutMs: 999_999
    });
    expect(send).toHaveBeenCalledWith(
      "request_feedback",
      "g",
      expect.objectContaining({ timeoutMs: 290_000 }),
      expect.anything(),
      undefined,
      300_000
    );
  });

  it("summarizes a confirm response", async () => {
    const tools = interactive({ responded: true, annotations: [{ kind: "confirm", value: true }] });
    expect(
      text(await exec(tools, "browser_request_feedback", { group: "g", mode: "confirm" }))
    ).toMatch(/confirmed/i);
  });

  it("reports a timeout as no response", async () => {
    const tools = interactive({ responded: false, timedOut: true, annotations: [] });
    expect(
      text(await exec(tools, "browser_request_feedback", { group: "g", mode: "confirm" }))
    ).toMatch(/no response/i);
  });

  it("resolves a point response to its element ref in the summary", async () => {
    const tools = interactive({
      responded: true,
      annotations: [{ kind: "point", x: 10, y: 20, ref: "e42", selector: "#x" }]
    });
    expect(
      text(await exec(tools, "browser_request_feedback", { group: "g", mode: "point" }))
    ).toMatch(/ref e42/);
  });
});

describe("browser_request_feedback rich modes (Phase 2)", () => {
  const interactive = (result: unknown) =>
    createBrowserTools(
      deps({ send: fakeSend(result), options: baseOptions({ groups: ["interactive"] }) })
    );
  const ask = (tools: Tools, mode: string) =>
    exec(tools, "browser_request_feedback", { group: "g", mode });

  it("summarizes an element selection by ref", async () => {
    const tools = interactive({
      responded: true,
      annotations: [{ kind: "element", ref: "e9", selector: "#x", text: "Inbox" }]
    });
    expect(text(await ask(tools, "element"))).toMatch(/selected ref e9/);
  });

  it("summarizes a region with covered refs", async () => {
    const tools = interactive({
      responded: true,
      annotations: [
        { kind: "region", rect: { x: 0, y: 0, width: 120, height: 60 }, refs: ["e1", "e2"] }
      ]
    });
    expect(text(await ask(tools, "region"))).toMatch(/120×60 region covering e1, e2/);
  });

  it("includes a comment note in the summary", async () => {
    const tools = interactive({
      responded: true,
      annotations: [{ kind: "point", x: 1, y: 2, ref: "e3", text: "this label is wrong" }]
    });
    expect(text(await ask(tools, "comment"))).toMatch(/this label is wrong/);
  });

  it("surfaces an overlay error distinctly from a timeout", async () => {
    const tools = interactive({ responded: false, error: "page blocked the overlay" });
    const output = text(await ask(tools, "point"));
    expect(output).toMatch(/page blocked the overlay/);
    expect(output).toMatch(/screenshot\/snapshot/);
  });
});
