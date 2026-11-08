import type { TelemetryRecorder } from "@vymalo/opencode-core-otel";
import { describe, expect, it, vi } from "vitest";

import { createEventBridge, EVENT_TYPES, type HostEvent } from "../src/events.js";
import { events, silentLogger } from "./helpers.js";

function setup() {
  const onEvent = vi.fn();
  const onTextComplete = vi.fn();
  const onBranch = vi.fn();
  const logger = silentLogger();
  const bridge = createEventBridge({
    recorder: { onEvent, onTextComplete } as unknown as TelemetryRecorder,
    logger,
    onBranch
  });
  const send = (event: unknown) => bridge.handle(event as HostEvent);
  return { bridge, send, onEvent, onTextComplete, onBranch, logger };
}

describe("EVENT_TYPES", () => {
  it("subscribes only to events with a v2 source — no session.diff, todo.updated or command.executed", () => {
    expect(EVENT_TYPES).not.toContain("session.diff");
    expect(EVENT_TYPES).not.toContain("todo.updated");
    expect(EVENT_TYPES).not.toContain("command.executed");
  });
});

describe("event bridge: v2 event -> engine vocabulary", () => {
  it("maps session.created, flattening the v2 payload into SessionInfo", () => {
    const { send, onEvent } = setup();
    send(events.sessionCreated("ses_1", { parentID: "ses_0" }));
    expect(onEvent).toHaveBeenCalledWith({
      type: "session.created",
      properties: { info: { id: "ses_1", parentID: "ses_0", directory: "/repo" } }
    });
  });

  it("maps idle, deleted, compaction and shutdown", () => {
    const { send, onEvent } = setup();
    send(events.sessionIdle("ses_1"));
    send({ type: "session.deleted", created: 1, data: { sessionID: "ses_1" } });
    send({ type: "session.compaction.ended", created: 1, data: { sessionID: "ses_1" } });
    send({ type: "location.shutdown", created: 1, data: {} });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      { type: "session.deleted", properties: { info: { id: "ses_1" } } },
      { type: "session.compacted", properties: { sessionID: "ses_1" } },
      { type: "server.instance.disposed" }
    ]);
  });

  it("maps a retry status (with its attempt) and a busy status", () => {
    const { send, onEvent } = setup();
    send({
      type: "session.status",
      created: 1,
      data: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 5 }
      }
    });
    send({
      type: "session.status",
      created: 1,
      data: { sessionID: "ses_1", status: { type: "busy" } }
    });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2 } }
      },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }
    ]);
  });

  it("reassembles a step started + ended into the one assistant message the engine records", () => {
    const { send, onEvent } = setup();
    send(events.stepStarted());
    send(events.stepEnded());

    const [started, ended] = onEvent.mock.calls.map(([event]) => event);
    expect(started).toEqual({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          modelID: "kimi-k2.6",
          providerID: "camer-digital",
          mode: "build",
          time: { created: 1_000 }
        }
      }
    });
    expect(ended).toEqual({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          modelID: "kimi-k2.6",
          providerID: "camer-digital",
          mode: "build",
          cost: 0.0125,
          tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 9600, write: 400 } },
          time: { created: 1_000, completed: 3_500 },
          finish: "stop"
        }
      }
    });
  });

  it("maps a failed step to an assistant message carrying the error", () => {
    const { send, onEvent } = setup();
    send(events.stepStarted());
    send(events.stepFailed());
    expect(onEvent.mock.calls[1]?.[0]).toMatchObject({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          error: { name: "ProviderError", data: { statusCode: 503 } },
          time: { created: 1_000, completed: 2_000 }
        }
      }
    });
  });

  it("omits the status code when the failure carries none", () => {
    const { send, onEvent } = setup();
    send(events.stepFailed({ error: { type: "Aborted", message: "x" } }));
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      properties: { info: { error: { name: "Aborted", data: {} } } }
    });
  });

  it("still records a step it never saw start (plugin loaded mid-turn)", () => {
    const { send, onEvent } = setup();
    send(events.stepEnded());
    const [event] = onEvent.mock.calls[0] ?? [];
    expect(event.properties.info).not.toHaveProperty("modelID");
    expect(event.properties.info.time).toEqual({ created: 3_500, completed: 3_500 });
  });

  it("maps permission asked/replied onto the engine's permission vocabulary", () => {
    const { send, onEvent } = setup();
    send({
      type: "permission.asked",
      created: 1,
      data: { id: "perm_1", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }
    });
    send({
      type: "permission.replied",
      created: 1,
      data: { sessionID: "ses_1", requestID: "perm_1", reply: "once" }
    });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "permission.updated",
        properties: { id: "perm_1", type: "edit", sessionID: "ses_1" }
      },
      {
        type: "permission.replied",
        properties: { sessionID: "ses_1", permissionID: "perm_1", response: "once" }
      }
    ]);
  });

  it("hands assistant text to the recorder for its length only, and the branch to the resource", () => {
    const { send, onTextComplete, onBranch } = setup();
    send({
      type: "session.text.ended",
      created: 1,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "abcd" }
    });
    send({ type: "vcs.branch.updated", created: 1, data: { branch: "main" } });
    send({ type: "vcs.branch.updated", created: 1, data: {} });
    expect(onTextComplete).toHaveBeenCalledWith("msg_1", "abcd");
    expect(onBranch).toHaveBeenCalledTimes(1);
    expect(onBranch).toHaveBeenCalledWith("main");
  });

  it("ignores an event type it does not translate", () => {
    const { send, onEvent } = setup();
    send({ type: "session.reasoning.delta", created: 1, data: {} });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("logs and survives a malformed event", () => {
    const { send, onEvent, logger } = setup();
    send({ type: "session.created", created: 1, data: { sessionID: "ses_1" } }); // no location
    send(events.sessionIdle());
    expect(logger.events.map(([name]) => name)).toContain("warn:otel_event_translation_failed");
    expect(onEvent).toHaveBeenCalledWith({
      type: "session.idle",
      properties: { sessionID: "ses_1" }
    });
  });
});

describe("event bridge: remembered state", () => {
  it("tracks each session's agent and model from events and the context hook", () => {
    const { send, bridge } = setup();
    expect(bridge.defaults("ses_1")).toBeUndefined();

    send(
      events.sessionCreated("ses_1", {
        agent: "plan",
        model: { id: "m1", providerID: "p1" }
      })
    );
    expect(bridge.defaults("ses_1")).toEqual({
      agent: "plan",
      model: { id: "m1", providerID: "p1" }
    });

    send({
      type: "session.agent.selected",
      created: 1,
      data: { sessionID: "ses_1", agent: "build" }
    });
    send({
      type: "session.model.selected",
      created: 1,
      data: { sessionID: "ses_1", model: { id: "m2", providerID: "p2" } }
    });
    expect(bridge.defaults("ses_1")).toEqual({
      agent: "build",
      model: { id: "m2", providerID: "p2" }
    });

    bridge.noteContext("ses_1", "review", { id: "m3", providerID: "p3" });
    expect(bridge.defaults("ses_1")).toEqual({
      agent: "review",
      model: { id: "m3", providerID: "p3" }
    });

    bridge.noteContext("ses_1", undefined, undefined);
    expect(bridge.defaults("ses_1")?.agent).toBe("review");
  });

  it("forgets a deleted session's state, including steps that never ended", () => {
    const { send, bridge } = setup();
    send(events.stepStarted());
    send(events.stepStarted({ sessionID: "ses_2", assistantMessageID: "msg_2" }));
    expect(bridge.size()).toEqual({ steps: 2, sessions: 2 });

    send({ type: "session.deleted", created: 1, data: { sessionID: "ses_1" } });
    expect(bridge.size()).toEqual({ steps: 1, sessions: 1 });
    expect(bridge.defaults("ses_1")).toBeUndefined();
  });

  it("releases a step when it ends", () => {
    const { send, bridge } = setup();
    send(events.stepStarted());
    send(events.stepEnded());
    expect(bridge.size().steps).toBe(0);
  });
});
