import type { RecorderEvent } from "@vymalo/opencode-core-otel";
import { describe, expect, it } from "vitest";

import {
  adaptContext,
  adaptPermission,
  adaptPrompt,
  adaptToolAfter,
  adaptToolBefore,
  OtelEventAdapter
} from "../src/otel-adapter.js";
import { hasOAuth2Conflict } from "../src/config.js";

function setup(now = () => 5000) {
  const events: RecorderEvent[] = [];
  const texts: Array<[string, string]> = [];
  const adapter = new OtelEventAdapter(
    { onEvent: (e) => events.push(e), onTextComplete: (id, text) => texts.push([id, text]) },
    now
  );
  return { adapter, events, texts };
}

const model = { id: "kimi-k2.6", providerID: "gateway" };
const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 3 } };

describe("OtelEventAdapter", () => {
  it("maps session.created / session.deleted", () => {
    const { adapter, events } = setup();
    adapter.handle({
      type: "session.created",
      data: { sessionID: "s1", parentID: "p", location: { directory: "/repo" } }
    });
    adapter.handle({ type: "session.deleted", data: { sessionID: "s1" } });
    adapter.handle({ type: "session.created", data: {} });
    adapter.handle({ type: "session.deleted", data: {} });
    expect(events).toEqual([
      {
        type: "session.created",
        properties: { info: { id: "s1", parentID: "p", directory: "/repo" } }
      },
      { type: "session.deleted", properties: { info: { id: "s1" } } }
    ]);
  });

  it("opens a message on step.started and closes it on step.ended with model, cost and tokens", () => {
    const { adapter, events } = setup();
    adapter.handle({
      type: "session.step.started",
      data: { sessionID: "s1", assistantMessageID: "m1", agent: "build", model, started: 1000 }
    });
    adapter.handle({
      type: "session.step.ended",
      created: 2000,
      data: { sessionID: "s1", assistantMessageID: "m1", finish: "stop", cost: 0.5, tokens }
    });
    expect(events[0]).toMatchObject({
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          role: "assistant",
          modelID: "kimi-k2.6",
          mode: "build",
          time: { created: 1000 }
        }
      }
    });
    expect(events[1]).toMatchObject({
      properties: {
        info: {
          id: "m1",
          modelID: "kimi-k2.6",
          providerID: "gateway",
          cost: 0.5,
          finish: "stop",
          tokens,
          time: { created: 1000, completed: 2000 }
        }
      }
    });
  });

  it("maps step.failed to an errored, completed message and tolerates a missing start", () => {
    const { adapter, events } = setup();
    adapter.handle({
      type: "session.step.failed",
      data: { sessionID: "s1", assistantMessageID: "m9", error: { type: "api", status: 429 } }
    });
    expect(events[0]).toMatchObject({
      properties: {
        info: {
          id: "m9",
          finish: "error",
          error: { name: "api", data: { statusCode: 429 } },
          time: { created: 5000, completed: 5000 }
        }
      }
    });
  });

  it("ignores malformed step events", () => {
    const { adapter, events } = setup();
    adapter.handle({ type: "session.step.started", data: { sessionID: "s" } });
    adapter.handle({ type: "session.step.ended", data: {} });
    adapter.handle({ type: "session.step.ended" });
    expect(events).toEqual([]);
  });

  it("forwards text length via onTextComplete", () => {
    const { adapter, texts } = setup();
    adapter.handle({
      type: "session.text.ended",
      data: { assistantMessageID: "m1", text: "abcd" }
    });
    adapter.handle({ type: "session.text.ended", data: { text: "x" } });
    expect(texts).toEqual([["m1", "abcd"]]);
  });

  it("maps retry, compaction and the execution lifecycle", () => {
    const { adapter, events } = setup();
    adapter.handle({ type: "session.retry.scheduled", data: { sessionID: "s1", attempt: 2 } });
    adapter.handle({ type: "session.compaction.ended", data: { sessionID: "s1" } });
    adapter.handle({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    adapter.handle({ type: "session.execution.interrupted", data: { sessionID: "s1" } });
    adapter.handle({
      type: "session.execution.failed",
      data: { sessionID: "s1", error: { type: "boom", status: 500 } }
    });
    adapter.handle({ type: "session.execution.failed", data: {} });
    expect(events.map((e) => e.type)).toEqual([
      "session.status",
      "session.compacted",
      "session.idle",
      "session.idle",
      "session.error",
      "session.idle"
    ]);
    expect(events[0]).toMatchObject({ properties: { status: { type: "retry", attempt: 2 } } });
  });

  it("maps permission asked / replied and the resource events", () => {
    const { adapter, events } = setup();
    adapter.handle({
      type: "permission.asked",
      data: { id: "perm", sessionID: "s1", action: "edit" }
    });
    adapter.handle({
      type: "permission.replied",
      data: { sessionID: "s1", requestID: "perm", reply: "once" }
    });
    adapter.handle({ type: "permission.asked", data: { sessionID: "s1" } });
    adapter.handle({ type: "vcs.branch.updated", data: { branch: "main" } });
    adapter.handle({ type: "installation.updated", data: { version: "2.2.6" } });
    adapter.handle({ type: "installation.updated", data: {} });
    adapter.handle({ type: "something.else", data: {} });
    expect(events).toEqual([
      { type: "permission.updated", properties: { id: "perm", type: "edit", sessionID: "s1" } },
      {
        type: "permission.replied",
        properties: { sessionID: "s1", permissionID: "perm", response: "once" }
      },
      { type: "vcs.branch.updated", properties: { branch: "main" } },
      { type: "installation.updated", properties: { version: "2.2.6" } }
    ]);
  });
});

describe("hook adapters", () => {
  it("flattens a prompt to text + file parts and carries the model", () => {
    const [input, output] = adaptPrompt({
      sessionID: "s",
      agent: "build",
      model,
      prompt: { text: "hi", files: [{}, {}] }
    });
    expect(input).toEqual({ sessionID: "s", agent: "build", model });
    expect(output.parts).toEqual([
      { type: "text", text: "hi" },
      { type: "file" },
      { type: "file" }
    ]);
    expect(adaptPrompt({ sessionID: "s", prompt: undefined })[1].parts).toEqual([
      { type: "text", text: "" }
    ]);
  });

  it("picks sampling parameters out of context options", () => {
    const [, output] = adaptContext({
      sessionID: "s",
      options: { temperature: 0.1, topP: 0.9, topK: 4, maxTokens: 10, other: 1 }
    });
    expect(output).toEqual({ temperature: 0.1, topP: 0.9, topK: 4, maxTokens: 10 });
    expect(adaptContext({ sessionID: "s" })[1]).toEqual({
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      maxTokens: undefined
    });
  });

  it("adapts tool and permission payloads", () => {
    expect(adaptToolBefore({ tool: "t", sessionID: "s", id: "c" })).toEqual({
      tool: "t",
      sessionID: "s",
      id: "c"
    });
    expect(
      adaptToolAfter({
        tool: "t",
        sessionID: "s",
        id: "c",
        status: "completed",
        result: { content: "ok" }
      })[1]
    ).toEqual({ content: "ok" });
    expect(
      adaptToolAfter({ tool: "t", sessionID: "s", id: "c", status: "error" })[1]
    ).toBeUndefined();
    expect(adaptPermission({ sessionID: "s", action: "edit", effect: "deny" })).toEqual([
      { sessionID: "s", type: "edit" },
      { status: "deny" }
    ]);
  });
});

describe("hasOAuth2Conflict", () => {
  const lookup = (settings: unknown) => ({ get: () => ({ provider: { settings } }) });
  it("detects both opt-in keys and the managed marker", () => {
    expect(hasOAuth2Conflict(lookup({ oauth2: { managed: true } }), "p")).toBe(true);
    expect(hasOAuth2Conflict(lookup({ oauth2ModelSync: {} }), "p")).toBe(true);
  });
  it("is false for unrelated settings or an unknown provider", () => {
    expect(hasOAuth2Conflict(lookup({ baseURL: "x" }), "p")).toBe(false);
    expect(hasOAuth2Conflict(lookup({ oauth2: "nope" }), "p")).toBe(false);
    expect(hasOAuth2Conflict({ get: () => undefined }, "p")).toBe(false);
  });
});
