import { ExportResultCode } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace";
import type { TelemetryRecorder } from "@vymalo/opencode-core-otel";
import { describe, expect, it, vi } from "vitest";

import { EVENT_TYPES } from "../src/events.js";
import { createOtelPlugin, OpencodeOtelPlugin, PLUGIN_ID } from "../src/opencode.js";
import { events, fakeCtx, silentLogger, start } from "./helpers.js";

const ENDPOINT = { endpoint: "http://localhost:4318" };

async function load(
  options: Record<string, unknown> = ENDPOINT,
  env: Record<string, string> = {},
  deferredTimeoutMs = 5
) {
  const logger = silentLogger();
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const fake = fakeCtx(options);
  let recorder: TelemetryRecorder | undefined;
  const running = await start(
    createOtelPlugin({
      logger,
      env,
      registerProcessHandlers: false,
      onRecorder: (r) => {
        recorder = r;
      },
      hostInfo: { hostname: "test-host" },
      // Keep the resource's deferred attributes from holding up the first export.
      deferredTimeoutMs,
      exporters: { trace: () => spans, log: () => logs, metric: () => undefined }
    }),
    fake.ctx
  );
  return { fake, logger, spans, logs, running, recorder: () => recorder as TelemetryRecorder };
}

type Logs = InMemoryLogRecordExporter;

const record = (logs: Logs, name: string) =>
  logs.getFinishedLogRecords().find((r) => r.attributes["event.name"] === name);
const names = (logs: Logs) => logs.getFinishedLogRecords().map((r) => r.attributes["event.name"]);

describe("createOtelPlugin", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("vymalo.otel");
    expect(createOtelPlugin().id).toBe(PLUGIN_ID);
    expect(OpencodeOtelPlugin.id).toBe(PLUGIN_ID);
  });

  it("stays inert — registers nothing and subscribes to nothing — when unconfigured", async () => {
    const { fake, logger } = await load({});
    expect(fake.registered()).toEqual([]);
    expect(fake.feed.stats().subscribed).toBe(0);
    expect(logger.events).toContainEqual([
      "info:otel_plugin_inactive",
      { enabled: true, reason: "no_exporter_configured" }
    ]);
  });

  it("reports being switched off explicitly", async () => {
    const { fake, logger } = await load({ ...ENDPOINT, enabled: false });
    expect(fake.registered()).toEqual([]);
    expect(logger.events).toContainEqual([
      "info:otel_plugin_inactive",
      { enabled: false, reason: "disabled" }
    ]);
  });

  it("activates from the environment alone", async () => {
    const { fake } = await load({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(fake.feed.stats().subscribed).toBe(1);
  });

  it("registers exactly the observing hooks and subscribes to the translated event set", async () => {
    const { fake } = await load();
    expect(fake.registered()).toEqual([
      "permission:evaluate",
      "session:context",
      "session:model.request",
      "session:prompt",
      "tool:execute.after",
      "tool:execute.before"
    ]);
    expect(fake.feed.stats().subscribed).toBe(1);
    expect(fake.feed.stats().types).toEqual(EVENT_TYPES);
  });

  it("registers no model.request hook when propagation is off", async () => {
    const { fake } = await load({ ...ENDPOINT, propagateTraceContext: false });
    expect(fake.registered()).not.toContain("session:model.request");
  });

  it("interrupts the event stream when the plugin scope closes", async () => {
    const { fake, running } = await load();
    // A barrier round-trip proves the consumer fiber is running and blocked on the feed.
    await fake.feed.emit();
    expect(fake.feed.stats().closed).toBe(0);
    await running.close();
    expect(fake.feed.stats().closed).toBe(1);
  });
});

describe("recording a session through the v2 hooks and events", () => {
  it("records spans, cost and all five token types", async () => {
    const { fake, spans, logs } = await load();

    await fake.feed.emit(events.sessionCreated());
    await fake.run("session:context", {
      sessionID: "ses_1",
      agent: "build",
      model: { id: "kimi-k2.6", providerID: "camer-digital" },
      options: { temperature: 0.3, topP: 0.9, topK: 40, maxTokens: 4096 }
    });
    await fake.run("tool:execute.before", {
      tool: "edit",
      sessionID: "ses_1",
      id: "call_1",
      input: { file: "a.ts" }
    });
    await fake.run("tool:execute.after", {
      tool: "edit",
      sessionID: "ses_1",
      id: "call_1",
      status: "completed",
      result: { content: "done" }
    });
    await fake.feed.emit(
      events.stepStarted(),
      {
        type: "session.text.ended",
        created: 2_000,
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "abcd" }
      },
      events.stepEnded(),
      events.sessionIdle()
    );

    // `session.idle` fires a flush, but the exporter must first await the
    // resource's deferred attributes, so the export lands a tick later.
    await vi.waitFor(() => expect(spans.getFinishedSpans().length).toBeGreaterThan(0));
    const spanNames = spans.getFinishedSpans().map((span) => span.name);
    expect(spanNames).toContain("execute_tool edit");
    expect(spanNames).toContain("chat kimi-k2.6");
    expect(spanNames).toContain("invoke_agent opencode");

    await vi.waitFor(() => expect(record(logs, "opencode.assistant_response")).toBeDefined());
    expect(record(logs, "opencode.assistant_response")?.attributes).toMatchObject({
      "gen_ai.request.model": "kimi-k2.6",
      "gen_ai.provider.name": "camer-digital",
      "gen_ai.agent.name": "build",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 340,
      "gen_ai.usage.reasoning_tokens": 88,
      "gen_ai.usage.cache_read_tokens": 9600,
      "gen_ai.usage.cache_write_tokens": 400,
      "opencode.cost.usage": 0.0125,
      "opencode.response.duration_ms": 2_500,
      "opencode.response.length": 4,
      "gen_ai.request.temperature": 0.3,
      "gen_ai.request.top_p": 0.9,
      "gen_ai.request.top_k": 40,
      "gen_ai.request.max_tokens": 4096,
      "gen_ai.response.finish_reasons": ["stop"]
    });
    expect(record(logs, "opencode.tool_result")?.attributes).toMatchObject({
      "gen_ai.tool.name": "edit",
      "opencode.tool.status": "ok",
      "opencode.tool.output.size": 4
    });
  });

  it("records a failing tool from execute.after's error status", async () => {
    const { fake, logs } = await load();
    await fake.feed.emit(events.sessionCreated());
    await fake.run("tool:execute.after", {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_2",
      status: "error",
      error: { message: "exit 1" }
    });
    await fake.feed.emit(events.sessionIdle());
    await vi.waitFor(() => expect(record(logs, "opencode.tool_result")).toBeDefined());
    expect(record(logs, "opencode.tool_result")?.attributes["opencode.tool.status"]).toBe("error");
  });

  it("records a failed step as an api_error with the status code", async () => {
    const { fake, logs } = await load();
    await fake.feed.emit(
      events.sessionCreated(),
      events.stepStarted(),
      events.stepFailed(),
      events.sessionIdle()
    );
    await vi.waitFor(() => expect(record(logs, "opencode.api_error")).toBeDefined());
    expect(record(logs, "opencode.api_error")?.attributes).toMatchObject({
      "error.type": "ProviderError",
      "http.response.status_code": 503
    });
    expect(record(logs, "opencode.assistant_response")?.attributes["error.type"]).toBe(
      "ProviderError"
    );
  });

  it("records a retry status, a compaction and a session start", async () => {
    const { fake, logs } = await load();
    await fake.feed.emit(
      events.sessionCreated(),
      {
        type: "session.status",
        created: 1,
        data: {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 2, message: "rate limited", next: 5 }
        }
      },
      {
        type: "session.compaction.ended",
        created: 1,
        data: { sessionID: "ses_1", reason: "auto" }
      },
      events.sessionIdle()
    );
    await vi.waitFor(() => expect(names(logs)).toContain("opencode.session_idle"));
    expect(names(logs)).toEqual(
      expect.arrayContaining([
        "opencode.session_start",
        "opencode.api_error",
        "opencode.compaction"
      ])
    );
    expect(record(logs, "opencode.api_error")?.attributes["opencode.retry.attempt"]).toBe(2);
  });

  it("records permission decisions: user replies from events, config-resolved ones from the hook", async () => {
    const { fake, logs } = await load();
    await fake.feed.emit(
      events.sessionCreated(),
      {
        type: "permission.asked",
        created: 1,
        data: { id: "perm_1", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }
      },
      {
        type: "permission.replied",
        created: 1,
        data: { sessionID: "ses_1", requestID: "perm_1", reply: "once" }
      }
    );
    await fake.run("permission:evaluate", {
      sessionID: "ses_1",
      action: "bash",
      resources: ["ls"],
      effect: "allow"
    });
    // An undecided evaluation waits for the user's reply, so it must not be counted.
    await fake.run("permission:evaluate", {
      sessionID: "ses_1",
      action: "write",
      resources: ["b.ts"],
      effect: "ask"
    });
    await fake.feed.emit(events.sessionIdle());

    await vi.waitFor(() => expect(names(logs)).toContain("opencode.session_idle"));
    const decisions = logs
      .getFinishedLogRecords()
      .filter((r) => r.attributes["event.name"] === "opencode.tool_decision")
      .map((r) => [
        r.attributes["opencode.permission.source"],
        r.attributes["opencode.permission.decision"],
        r.attributes["gen_ai.tool.name"]
      ]);
    expect(decisions).toEqual([
      ["user", "once", "edit"],
      ["auto", "allow", "bash"]
    ]);
  });

  it("describes the prompt by shape, attributing it to the session's last agent and model", async () => {
    const { fake, logs } = await load();
    await fake.feed.emit(
      events.sessionCreated("ses_1", { agent: "plan", model: { id: "m1", providerID: "p1" } })
    );
    await fake.run("session:prompt", {
      sessionID: "ses_1",
      prompt: { text: "hello", files: [{ uri: "file:///a.png" }, { uri: "file:///b.png" }] }
    });
    await fake.feed.emit(events.sessionIdle());

    await vi.waitFor(() => expect(record(logs, "opencode.user_prompt")).toBeDefined());
    expect(record(logs, "opencode.user_prompt")?.attributes).toMatchObject({
      "opencode.prompt.length": 5,
      "opencode.prompt.part_count": 3,
      "opencode.prompt.parts.text": 1,
      "opencode.prompt.parts.file": 2,
      "gen_ai.agent.name": "plan",
      "gen_ai.request.model": "m1",
      "gen_ai.provider.name": "p1"
    });
  });
});

describe("no content capture", () => {
  it("never exports prompt, response or tool text — sizes only", async () => {
    const { fake, spans, logs } = await load();
    const SECRETS = ["PROMPT-SECRET-7", "REPLY-SECRET-8", "TOOL-OUTPUT-SECRET-9", "ARGS-SECRET-10"];

    await fake.feed.emit(events.sessionCreated());
    await fake.run("session:prompt", {
      sessionID: "ses_1",
      prompt: { text: SECRETS[0] }
    });
    await fake.run("session:context", {
      sessionID: "ses_1",
      agent: "build",
      model: { id: "kimi-k2.6", providerID: "camer-digital" },
      options: {}
    });
    await fake.run("tool:execute.before", {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      input: { command: SECRETS[3] }
    });
    await fake.run("tool:execute.after", {
      tool: "bash",
      sessionID: "ses_1",
      id: "call_1",
      input: { command: SECRETS[3] },
      status: "completed",
      result: { content: SECRETS[2], output: SECRETS[2] }
    });
    await fake.feed.emit(
      events.stepStarted(),
      {
        type: "session.text.ended",
        created: 2_000,
        data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: SECRETS[1] }
      },
      events.stepEnded(),
      {
        type: "permission.asked",
        created: 1,
        data: {
          id: "perm_1",
          sessionID: "ses_1",
          action: "bash",
          resources: [SECRETS[3]],
          message: SECRETS[3],
          metadata: { command: SECRETS[3] }
        }
      },
      events.sessionIdle()
    );

    await vi.waitFor(() => expect(spans.getFinishedSpans().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(record(logs, "opencode.assistant_response")).toBeDefined());

    const exported = JSON.stringify([
      spans.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events
      })),
      logs.getFinishedLogRecords().map((r) => ({ body: r.body, attributes: r.attributes }))
    ]);
    for (const secret of SECRETS) {
      expect(exported).not.toContain(secret);
    }
    // ...while the sizes that stand in for them are there.
    expect(record(logs, "opencode.user_prompt")?.attributes["opencode.prompt.length"]).toBe(
      SECRETS[0]?.length
    );
    expect(
      record(logs, "opencode.assistant_response")?.attributes["opencode.response.length"]
    ).toBe(SECRETS[1]?.length);
    expect(record(logs, "opencode.tool_result")?.attributes["opencode.tool.output.size"]).toBe(
      SECRETS[2]?.length
    );
  });
});

describe("trace-context propagation (session.hook model.request)", () => {
  const primary = (headers: Record<string, string> = {}) => ({
    sessionID: "ses_1",
    agent: "build",
    model: { id: "kimi-k2.6", providerID: "camer-digital" },
    kind: "primary",
    headers
  });

  async function withOpenChat() {
    const loaded = await load();
    await loaded.fake.feed.emit(events.sessionCreated());
    await loaded.fake.run("session:context", {
      sessionID: "ses_1",
      agent: "build",
      model: { id: "kimi-k2.6", providerID: "camer-digital" },
      options: {}
    });
    return loaded;
  }

  it("injects a traceparent for the in-flight chat on a primary request", async () => {
    const { fake, spans } = await withOpenChat();
    const request = primary();
    await fake.run("session:model.request", request);

    expect(request.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // ...and it is the chat span's own context.
    await fake.feed.emit(events.stepStarted(), events.stepEnded(), events.sessionIdle());
    await vi.waitFor(() => expect(spans.getFinishedSpans().length).toBeGreaterThan(0));
    const chat = spans.getFinishedSpans().find((span) => span.name === "chat kimi-k2.6");
    const [, traceId, spanId] = request.headers.traceparent?.split("-") ?? [];
    expect(chat?.spanContext().traceId).toBe(traceId);
    expect(chat?.spanContext().spanId).toBe(spanId);
  });

  it("never clobbers a traceparent something upstream already set, whatever its casing", async () => {
    const { fake } = await withOpenChat();
    const request = primary({ TraceParent: "00-upstream-upstream-01" });
    await fake.run("session:model.request", request);
    expect(request.headers).toEqual({ TraceParent: "00-upstream-upstream-01" });
  });

  it("leaves auxiliary requests (title, compaction, generate) alone", async () => {
    const { fake } = await withOpenChat();
    for (const kind of ["title", "compaction", "generate"]) {
      const request = { ...primary(), kind };
      await fake.run("session:model.request", request);
      expect(request.headers).toEqual({});
    }
  });

  it("injects nothing when no chat is in flight", async () => {
    const { fake } = await load();
    const request = primary();
    await fake.run("session:model.request", request);
    expect(request.headers).toEqual({});
  });

  it("injects nothing when two chats are in flight (an ambiguous parent is worse than none)", async () => {
    const { fake } = await withOpenChat();
    await fake.run("session:context", {
      sessionID: "ses_2",
      agent: "build",
      model: { id: "kimi-k2.6", providerID: "camer-digital" },
      options: {}
    });
    const request = primary();
    await fake.run("session:model.request", request);
    expect(request.headers).toEqual({});
  });
});

describe("failure isolation", () => {
  it("never lets a hook throw into the host", async () => {
    const { fake, logger, recorder } = await load();
    vi.spyOn(recorder(), "onToolBefore").mockImplementation(() => {
      throw new Error("recorder exploded");
    });
    await expect(
      fake.run("tool:execute.before", { tool: "bash", sessionID: "ses_1", id: "c1" })
    ).resolves.toBeUndefined();
    expect(logger.events).toContainEqual([
      "warn:otel_hook_failed",
      { hook: "execute.before", error: "recorder exploded" }
    ]);
  });

  it("keeps consuming events after a malformed one", async () => {
    const { fake, logger, logs } = await load();
    await fake.feed.emit(
      { type: "session.created", created: 1, data: { sessionID: "ses_bad" } },
      events.sessionCreated(),
      events.sessionIdle()
    );
    expect(logger.events.map(([name]) => name)).toContain("warn:otel_event_translation_failed");
    await vi.waitFor(() => expect(names(logs)).toContain("opencode.session_idle"));
  });
});

describe("fail-closed credential gate (ADR-0015)", () => {
  function spyExporter() {
    const exportSpy = vi.fn((_spans: unknown, done: (result: unknown) => void) =>
      done({ code: ExportResultCode.SUCCESS })
    );
    return {
      exportSpy,
      exporter: { export: exportSpy, shutdown: async () => {} } as unknown as SpanExporter
    };
  }

  async function runWithTokenCommand(tokenCommand: string[]) {
    const { exporter, exportSpy } = spyExporter();
    const fake = fakeCtx({ ...ENDPOINT, tokenCommand });
    const logger = silentLogger();
    await start(
      createOtelPlugin({
        logger,
        env: {},
        registerProcessHandlers: false,
        hostInfo: { hostname: "test-host" },
        deferredTimeoutMs: 5,
        exporters: { trace: () => exporter, log: () => undefined, metric: () => undefined }
      }),
      fake.ctx
    );
    // `session.idle` forces a flush; the span it ends is what gets exported.
    await fake.feed.emit(events.sessionCreated(), events.sessionIdle());
    return { exportSpy, logger };
  }

  it("never reaches the OTLP exporter while the credential helper has no token", async () => {
    const { exportSpy, logger } = await runWithTokenCommand(["node", "-e", "process.exit(1)"]);
    // The skip is the observable proof that the gate ran and refused the export.
    await vi.waitFor(() =>
      expect(logger.events.map(([name]) => name)).toContain(
        "debug:otel_export_skipped_no_credential"
      )
    );
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("exports once the credential helper yields a token", async () => {
    const { exportSpy, logger } = await runWithTokenCommand([
      "node",
      "-e",
      "process.stdout.write('tok')"
    ]);
    await vi.waitFor(() => expect(exportSpy).toHaveBeenCalled());
    expect(logger.events.map(([name]) => name)).not.toContain(
      "debug:otel_export_skipped_no_credential"
    );
  });
});

describe("exit handling", () => {
  it("registers the shared exit handlers and drains telemetry on beforeExit, exactly once", async () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM")
    };

    await start(
      createOtelPlugin({
        logger: silentLogger(),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
        exporters: {
          trace: () => undefined,
          metric: () => undefined,
          log: () => new InMemoryLogRecordExporter()
        }
      }),
      fakeCtx({}).ctx
    );

    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
    try {
      process.emit("beforeExit", 0);
      process.emit("beforeExit", 0);
    } finally {
      // Never fire a real signal here: ours would re-raise it at the test runner.
      // The re-raise semantics are tested against an injected process in
      // `@vymalo/opencode-core-otel` (test/exit-handlers.test.ts).
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const [handler] = process.listeners(signal).slice(-1);
        if (handler) {
          process.removeListener(signal, handler as never);
        }
      }
    }
    // The `once` handler removed itself, so a second beforeExit is a no-op.
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });
});

describe("resource", () => {
  it("stamps the host version and the branch once its event arrives", async () => {
    // The deferred branch attribute gives up after a wall-clock timeout that
    // starts at plugin construction. This test is about the *event* settling
    // it, so the timeout must not fire first (the timer is unref'd, so a long
    // value holds nothing open). `emit` resolves only after the branch event
    // was handled, so there is no race with the export either.
    const { fake, logs } = await load(ENDPOINT, {}, 60_000);
    await fake.feed.emit(
      { type: "vcs.branch.updated", created: 1, data: { branch: "release/x" } },
      events.sessionCreated(),
      events.sessionIdle()
    );

    await vi.waitFor(() => expect(logs.getFinishedLogRecords().length).toBeGreaterThan(0));
    const resource = logs.getFinishedLogRecords()[0]?.resource;
    await resource?.waitForAsyncAttributes?.();
    expect(resource?.attributes["vcs.repository.ref.name"]).toBe("release/x");
    // No `hostInfo.version` override here: it comes from `ctx.app.version`.
    expect(resource?.attributes["service.version"]).toBe("2.2.6");
    expect(resource?.attributes["host.name"]).toBe("test-host");
  });
});
