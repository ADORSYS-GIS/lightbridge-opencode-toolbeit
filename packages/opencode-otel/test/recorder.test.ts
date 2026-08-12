import { beforeEach, describe, expect, it } from "vitest";

import { TelemetryRecorder } from "../src/recorder.js";
import {
  assistantMessage,
  harness,
  type Harness,
  logsNamed,
  metricNamed,
  points
} from "./helpers.js";

let env: Harness;
let recorder: TelemetryRecorder;
let clock: number;

function build(options: Parameters<typeof harness>[0] = {}): void {
  env = harness(options);
  clock = 10_000;
  recorder = new TelemetryRecorder({
    providers: env.providers,
    config: env.config,
    logger: env.logger,
    now: () => clock
  });
}

/** `onEvent` takes the SDK's discriminated union; tests feed it literals. */
function emit(event: unknown): void {
  recorder.onEvent(event as never);
}

function startSession(id = "ses_1", parentID?: string): void {
  emit({ type: "session.created", properties: { info: { id, parentID, directory: "/repo" } } });
}

beforeEach(() => {
  build();
});

describe("sessions", () => {
  it("counts a session and opens a root span", async () => {
    startSession();
    emit({ type: "session.idle", properties: { sessionID: "ses_1" } });

    expect(points(metricNamed(await env.metrics(), "opencode.session.count"))).toEqual([
      [1, { "opencode.session.kind": "root" }]
    ]);

    const root = (await env.spans()).find((span) => span.name === "invoke_agent opencode");
    expect(root).toBeDefined();
    expect(root?.attributes["gen_ai.conversation.id"]).toBe("ses_1");
    expect(root?.attributes["gen_ai.agent.name"]).toBe("opencode");
  });

  it("labels a sub-session as a child", async () => {
    startSession("ses_child", "ses_parent");
    expect(points(metricNamed(await env.metrics(), "opencode.session.count"))).toEqual([
      [1, { "opencode.session.kind": "child" }]
    ]);
  });

  it("accumulates busy time between status transitions", async () => {
    startSession();
    emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    clock += 2_500;
    emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });

    expect(points(metricNamed(await env.metrics(), "opencode.active_time.total"))).toEqual([
      [2.5, {}]
    ]);
  });

  it("does not double-count a repeated busy status", async () => {
    startSession();
    emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    clock += 1_000;
    emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    clock += 1_000;
    emit({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } });

    expect(points(metricNamed(await env.metrics(), "opencode.active_time.total"))).toEqual([
      [2, {}]
    ]);
  });

  it("summarizes the session on idle", async () => {
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    clock += 5_000;
    emit({ type: "session.idle", properties: { sessionID: "ses_1" } });

    const [record] = logsNamed(await env.logs(), "opencode.session_idle");
    expect(record?.attributes["opencode.session.request_count"]).toBe(1);
    expect(record?.attributes["opencode.cost.usage"]).toBe(0.0125);
    expect(record?.attributes["gen_ai.usage.input_tokens"]).toBe(1200);
  });

  it("emits a retry as a warning-level api_error", async () => {
    startSession();
    emit({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "retry", attempt: 3 } }
    });

    const [record] = logsNamed(await env.logs(), "opencode.api_error");
    expect(record?.attributes["error.type"]).toBe("retry");
    expect(record?.attributes["opencode.retry.attempt"]).toBe(3);
  });
});

describe("assistant messages", () => {
  it("records real USD cost from the host", async () => {
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });

    const [[value, attributes]] = points(metricNamed(await env.metrics(), "opencode.cost.usage"));
    expect(value).toBeCloseTo(0.0125);
    expect(attributes["gen_ai.request.model"]).toBe("kimi-k2.6");
    expect(attributes["gen_ai.provider.name"]).toBe("camer-digital");
    expect(attributes["gen_ai.agent.name"]).toBe("build");
  });

  it("records all five token types, not just input and output", async () => {
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });

    const byType = new Map(
      points(metricNamed(await env.metrics(), "gen_ai.client.token.usage")).map(
        ([value, attributes]) => [attributes["gen_ai.token.type"] as string, value]
      )
    );
    expect(byType.get("input")).toBe(1200);
    expect(byType.get("output")).toBe(340);
    expect(byType.get("reasoning")).toBe(88);
    expect(byType.get("cache_read")).toBe(9600);
    expect(byType.get("cache_write")).toBe(400);
  });

  it("finalizes only once even though message.updated repeats", async () => {
    startSession();
    const info = assistantMessage();
    emit({ type: "message.updated", properties: { info } });
    emit({ type: "message.updated", properties: { info } });
    emit({ type: "message.updated", properties: { info } });

    expect(points(metricNamed(await env.metrics(), "opencode.session.request.count"))).toEqual([
      [1, expect.objectContaining({ "gen_ai.request.model": "kimi-k2.6" })]
    ]);
  });

  it("holds the chat span open until the message completes", async () => {
    startSession();
    const streaming = assistantMessage({ time: { created: 1_000 }, cost: 0, finish: undefined });
    emit({ type: "message.updated", properties: { info: streaming } });
    expect((await env.spans()).some((span) => span.name.startsWith("chat "))).toBe(false);

    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    const chat = (await env.spans()).find((span) => span.name === "chat kimi-k2.6");
    expect(chat).toBeDefined();
    expect(chat?.attributes["gen_ai.usage.cache_read_tokens"]).toBe(9600);
    expect(chat?.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
  });

  it("marks the span errored and emits an api_error when the message failed", async () => {
    startSession();
    emit({
      type: "message.updated",
      properties: {
        info: assistantMessage({
          error: { name: "APIError", data: { statusCode: 429, isRetryable: true } }
        })
      }
    });

    const chat = (await env.spans()).find((span) => span.name === "chat kimi-k2.6");
    expect(chat?.status.code).toBe(2 /* ERROR */);

    const [record] = logsNamed(await env.logs(), "opencode.api_error");
    expect(record?.attributes["error.type"]).toBe("APIError");
    expect(record?.attributes["http.response.status_code"]).toBe(429);
    expect(record?.attributes["opencode.error.retryable"]).toBe(true);
  });

  it("ignores user messages", async () => {
    startSession();
    emit({
      type: "message.updated",
      properties: { info: { id: "m", sessionID: "ses_1", role: "user" } }
    });
    expect(metricNamed(await env.metrics(), "opencode.cost.usage")).toBeUndefined();
  });

  it("records duration in seconds", async () => {
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    const [[value]] = points(metricNamed(await env.metrics(), "gen_ai.client.operation.duration"));
    expect(value).toBeCloseTo(2.5);
  });
});

describe("tools", () => {
  it("spans a tool call and counts it once", async () => {
    startSession();
    recorder.onToolBefore({ tool: "edit", sessionID: "ses_1", callID: "call_1" });
    clock += 120;
    recorder.onToolAfter(
      { tool: "edit", sessionID: "ses_1", callID: "call_1", args: {} },
      { output: "done" }
    );

    const span = (await env.spans()).find((s) => s.name === "execute_tool edit");
    expect(span?.attributes["gen_ai.tool.call.id"]).toBe("call_1");
    expect(span?.attributes["opencode.tool.duration_ms"]).toBe(120);

    expect(points(metricNamed(await env.metrics(), "opencode.tool.invocations"))).toEqual([
      [1, { "gen_ai.tool.name": "edit", "opencode.tool.status": "ok" }]
    ]);
  });

  it("counts a failing tool, which never reaches the after hook", async () => {
    startSession();
    recorder.onToolBefore({ tool: "bash", sessionID: "ses_1", callID: "call_2" });
    emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "call_2",
          tool: "bash",
          sessionID: "ses_1",
          state: { status: "error", time: { start: 100, end: 900 } }
        }
      }
    });

    expect(points(metricNamed(await env.metrics(), "opencode.tool.invocations"))).toEqual([
      [1, { "gen_ai.tool.name": "bash", "opencode.tool.status": "error" }]
    ]);
    const [record] = logsNamed(await env.logs(), "opencode.tool_result");
    expect(record?.attributes["opencode.tool.duration_ms"]).toBe(800);
    expect((await env.spans()).find((s) => s.name === "execute_tool bash")?.status.code).toBe(2);
  });

  it("does not double-count when both the hook and the part report a terminal state", async () => {
    startSession();
    recorder.onToolBefore({ tool: "read", sessionID: "ses_1", callID: "call_3" });
    recorder.onToolAfter(
      { tool: "read", sessionID: "ses_1", callID: "call_3", args: {} },
      { output: "x" }
    );
    emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "call_3",
          tool: "read",
          sessionID: "ses_1",
          state: { status: "completed", time: { start: 1, end: 2 } }
        }
      }
    });

    expect(points(metricNamed(await env.metrics(), "opencode.tool.invocations"))).toEqual([
      [1, { "gen_ai.tool.name": "read", "opencode.tool.status": "ok" }]
    ]);
    expect(logsNamed(await env.logs(), "opencode.tool_result")).toHaveLength(1);
  });

  it("ignores a non-terminal tool part", async () => {
    startSession();
    emit({
      type: "message.part.updated",
      properties: {
        part: { type: "tool", callID: "call_4", tool: "read", state: { status: "running" } }
      }
    });
    expect(metricNamed(await env.metrics(), "opencode.tool.invocations")).toBeUndefined();
  });

  it("suppresses the span for a filtered tool but keeps the metric", async () => {
    build({ filteredTools: ["read"] });
    startSession();
    recorder.onToolBefore({ tool: "read", sessionID: "ses_1", callID: "call_5" });
    recorder.onToolAfter(
      { tool: "read", sessionID: "ses_1", callID: "call_5", args: {} },
      { output: "x" }
    );

    expect((await env.spans()).some((s) => s.name.startsWith("execute_tool"))).toBe(false);
    expect(points(metricNamed(await env.metrics(), "opencode.tool.invocations"))).toHaveLength(1);
  });
});

describe("diffs", () => {
  it("counts only the delta of a cumulative session diff", async () => {
    startSession();
    emit({
      type: "session.diff",
      properties: {
        sessionID: "ses_1",
        diff: [{ file: "/repo/src/a.ts", additions: 10, deletions: 2 }]
      }
    });
    emit({
      type: "session.diff",
      properties: {
        sessionID: "ses_1",
        diff: [{ file: "/repo/src/a.ts", additions: 14, deletions: 2 }]
      }
    });

    const byType = new Map(
      points(metricNamed(await env.metrics(), "opencode.lines_of_code.count")).map(
        ([value, attributes]) => [attributes["opencode.change.type"] as string, value]
      )
    );
    expect(byType.get("added")).toBe(14);
    expect(byType.get("removed")).toBe(2);
  });

  it("tags the detected language and skips unknown extensions", async () => {
    startSession();
    emit({
      type: "session.diff",
      properties: {
        sessionID: "ses_1",
        diff: [
          { file: "/repo/main.rs", additions: 3, deletions: 0 },
          { file: "/repo/LICENSE", additions: 1, deletions: 0 }
        ]
      }
    });

    const languages = points(metricNamed(await env.metrics(), "opencode.lines_of_code.count")).map(
      ([, attributes]) => attributes["code.language"]
    );
    expect(languages).toContain("rust");
    expect(languages).toContain(undefined);
  });
});

describe("permissions and commands", () => {
  it("names the tool a decision resolved", async () => {
    startSession();
    emit({
      type: "permission.updated",
      properties: { id: "perm_1", type: "edit", sessionID: "ses_1", messageID: "m", title: "t" }
    });
    emit({
      type: "permission.replied",
      properties: { sessionID: "ses_1", permissionID: "perm_1", response: "allow" }
    });

    expect(points(metricNamed(await env.metrics(), "opencode.permission.decision.count"))).toEqual([
      [1, { "opencode.permission.decision": "allow", "gen_ai.tool.name": "edit" }]
    ]);
    expect(
      logsNamed(await env.logs(), "opencode.tool_decision")[0]?.attributes["opencode.permission.id"]
    ).toBe("perm_1");
  });

  it("still records a reply for an unseen permission", async () => {
    startSession();
    emit({
      type: "permission.replied",
      properties: { sessionID: "ses_1", permissionID: "perm_x", response: "deny" }
    });
    expect(points(metricNamed(await env.metrics(), "opencode.permission.decision.count"))).toEqual([
      [1, { "opencode.permission.decision": "deny" }]
    ]);
  });

  it("counts slash commands", async () => {
    startSession();
    emit({
      type: "command.executed",
      properties: { name: "review", sessionID: "ses_1", arguments: "", messageID: "m" }
    });
    expect(points(metricNamed(await env.metrics(), "opencode.command.executed.count"))).toEqual([
      [1, { "opencode.command.name": "review" }]
    ]);
  });

  it("counts a compaction and emits an instant span", async () => {
    startSession();
    emit({ type: "session.compacted", properties: { sessionID: "ses_1" } });
    expect(points(metricNamed(await env.metrics(), "opencode.session.compaction.count"))).toEqual([
      [1, {}]
    ]);
    expect((await env.spans()).some((span) => span.name === "session_compaction")).toBe(true);
  });
});

describe("prompts", () => {
  it("records prompt shape without any content", async () => {
    startSession();
    recorder.onChatMessage(
      {
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "camer-digital", modelID: "kimi-k2.6" }
      },
      {
        message: {} as never,
        parts: [{ type: "text", text: "hello world" }, { type: "file" }] as never
      }
    );

    const [record] = logsNamed(await env.logs(), "opencode.user_prompt");
    expect(record?.attributes["opencode.prompt.length"]).toBe(11);
    expect(record?.attributes["opencode.prompt.part_count"]).toBe(2);
    expect(record?.attributes["opencode.prompt.parts.text"]).toBe(1);
    expect(record?.attributes["gen_ai.agent.name"]).toBe("build");
    expect(JSON.stringify(record?.attributes)).not.toContain("hello world");
  });
});

describe("cardinality", () => {
  it("keeps the session id off metrics by default", async () => {
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    const [[, attributes]] = points(metricNamed(await env.metrics(), "opencode.cost.usage"));
    expect(attributes["gen_ai.conversation.id"]).toBeUndefined();
  });

  it("adds it when explicitly enabled", async () => {
    build({ includeSessionId: true });
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    const [[, attributes]] = points(metricNamed(await env.metrics(), "opencode.cost.usage"));
    expect(attributes["gen_ai.conversation.id"]).toBe("ses_1");
  });
});

describe("resilience", () => {
  it("swallows a malformed event instead of throwing into the host", () => {
    expect(() =>
      emit({ type: "session.diff", properties: { sessionID: "ses_1", diff: null } })
    ).not.toThrow();
    expect(env.logger.events.some(([name]) => name === "warn:otel_event_failed")).toBe(true);
  });

  it("ignores unknown event types", () => {
    expect(() => emit({ type: "lsp.updated", properties: {} })).not.toThrow();
  });

  it("closes open spans on shutdown", async () => {
    // The in-memory exporter clears itself on `shutdown()`, so this recorder
    // flushes instead of tearing down — the assertion is about the recorder
    // ending its own spans, not about provider teardown.
    recorder = new TelemetryRecorder({
      providers: { ...env.providers, shutdown: () => env.providers.forceFlush() },
      config: env.config,
      logger: env.logger,
      now: () => clock
    });
    startSession();
    recorder.onToolBefore({ tool: "edit", sessionID: "ses_1", callID: "open" });
    await recorder.shutdown();

    const names = (await env.spans()).map((span) => span.name);
    expect(names).toContain("execute_tool edit");
    expect(names).toContain("invoke_agent opencode");
  });
});

describe("partial payloads", () => {
  it("handles a message with no tokens, model or provider", async () => {
    startSession();
    emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_bare",
          sessionID: "ses_1",
          role: "assistant",
          cost: 0,
          time: { created: 1_000, completed: 1_400 }
        }
      }
    });

    expect(metricNamed(await env.metrics(), "opencode.cost.usage")).toBeUndefined();
    expect(metricNamed(await env.metrics(), "gen_ai.client.token.usage")).toBeUndefined();
    const [[value, attributes]] = points(
      metricNamed(await env.metrics(), "opencode.session.request.count")
    );
    expect(value).toBe(1);
    expect(attributes["gen_ai.request.model"]).toBeUndefined();
    expect((await env.spans()).some((span) => span.name === "chat unknown")).toBe(true);
  });

  it("records an error with no session id attached", async () => {
    emit({ type: "session.error", properties: { error: { name: "UnknownError" } } });
    const [record] = logsNamed(await env.logs(), "opencode.api_error");
    expect(record?.attributes["error.type"]).toBe("UnknownError");
    expect(record?.attributes["gen_ai.conversation.id"]).toBeUndefined();
  });

  it("falls back to a generic error type for an unnamed error", async () => {
    emit({ type: "session.error", properties: { sessionID: "ses_1", error: {} } });
    expect(
      (await env.logs()).some((record) => record.attributes["error.type"] === "UnknownError")
    ).toBe(true);
  });

  it("ignores idle for a session it never saw", async () => {
    emit({ type: "session.idle", properties: { sessionID: "ghost" } });
    expect(logsNamed(await env.logs(), "opencode.session_idle")).toHaveLength(0);
  });

  it("records a session diff for a session it never saw created", async () => {
    emit({
      type: "session.diff",
      properties: { sessionID: "late", diff: [{ file: "a.ts", additions: 4, deletions: 0 }] }
    });
    expect(points(metricNamed(await env.metrics(), "opencode.lines_of_code.count"))).toHaveLength(
      1
    );
  });

  it("skips a diff entry that has not changed", async () => {
    startSession();
    const diff = [{ file: "a.ts", additions: 3, deletions: 1 }];
    emit({ type: "session.diff", properties: { sessionID: "ses_1", diff } });
    emit({ type: "session.diff", properties: { sessionID: "ses_1", diff } });
    expect(logsNamed(await env.logs(), "opencode.file_edited")).toHaveLength(1);
  });

  it("omits output size when the tool returned no string", async () => {
    startSession();
    recorder.onToolBefore({ tool: "edit", sessionID: "ses_1", callID: "c" });
    recorder.onToolAfter({ tool: "edit", sessionID: "ses_1", callID: "c", args: {} }, {});
    const [record] = logsNamed(await env.logs(), "opencode.tool_result");
    expect(record?.attributes["opencode.tool.output.size"]).toBeUndefined();
  });

  it("records a tool result for a call it never saw start", async () => {
    startSession();
    recorder.onToolAfter(
      { tool: "grep", sessionID: "ses_1", callID: "unseen", args: {} },
      { output: "x" }
    );
    expect(points(metricNamed(await env.metrics(), "opencode.tool.invocations"))).toEqual([
      [1, { "gen_ai.tool.name": "grep", "opencode.tool.status": "ok" }]
    ]);
  });

  it("handles a prompt with no parts", async () => {
    startSession();
    recorder.onChatMessage({ sessionID: "ses_1" } as never, { parts: [] } as never);
    const [record] = logsNamed(await env.logs(), "opencode.user_prompt");
    expect(record?.attributes["opencode.prompt.length"]).toBe(0);
    expect(record?.attributes["opencode.prompt.part_count"]).toBe(0);
  });

  it("ignores a non-tool message part", async () => {
    startSession();
    emit({ type: "message.part.updated", properties: { part: { type: "text", text: "hi" } } });
    expect(metricNamed(await env.metrics(), "opencode.tool.invocations")).toBeUndefined();
  });
});

describe("no-signal mode", () => {
  it("records nothing but stays functional when every exporter is off", async () => {
    build({ exporters: { traces: "none", metrics: "none", logs: "none" } });
    startSession();
    emit({ type: "message.updated", properties: { info: assistantMessage() } });
    recorder.onToolBefore({ tool: "edit", sessionID: "ses_1", callID: "c" });
    recorder.onToolAfter(
      { tool: "edit", sessionID: "ses_1", callID: "c", args: {} },
      { output: "" }
    );
    emit({ type: "session.idle", properties: { sessionID: "ses_1" } });

    expect(await env.metrics()).toHaveLength(0);
    expect(await env.logs()).toHaveLength(0);
    expect(await env.spans()).toHaveLength(0);
    expect(recorder.currentChatContext()).toBeUndefined();
  });
});

describe("trace context handoff", () => {
  it("offers a context only while exactly one chat is in flight", () => {
    startSession();
    expect(recorder.currentChatContext()).toBeUndefined();

    emit({
      type: "message.updated",
      properties: { info: assistantMessage({ time: { created: 1_000 } }) }
    });
    expect(recorder.currentChatContext()).toBeDefined();

    // A second concurrent chat makes the parent ambiguous — better none than wrong.
    emit({
      type: "message.updated",
      properties: {
        info: assistantMessage({ id: "msg_2", sessionID: "ses_2", time: { created: 1_000 } })
      }
    });
    expect(recorder.currentChatContext()).toBeUndefined();
  });
});
