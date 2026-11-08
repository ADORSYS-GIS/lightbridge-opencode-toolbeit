import type { Plugin } from "@opencode/plugin/effect";
import type { Stream } from "effect";

import type { Logger, RecorderEvent, TelemetryRecorder } from "@vymalo/opencode-core-otel";

/**
 * The v2 events this plugin subscribes to — and nothing else, so the host does
 * not stream the (very chatty) delta events to a plugin that would drop them.
 *
 * Each one is translated into the engine's own vocabulary (`RecorderEvent`,
 * `@vymalo/opencode-core-otel`) by {@link EventBridge}; see `docs/otel.md` for
 * the full v1 -> v2 table.
 */
export const EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.idle",
  "session.status",
  "session.agent.selected",
  "session.model.selected",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.compaction.ended",
  "session.text.ended",
  "permission.asked",
  "permission.replied",
  "vcs.branch.updated",
  "location.shutdown"
] as const;

declare const hostSubscribe: Plugin.Context["event"]["subscribe"];

/** The `Stream` `ctx.event.subscribe({ types: EVENT_TYPES })` returns. */
export type HostEventStream = ReturnType<typeof hostSubscribe<(typeof EVENT_TYPES)[number]>>;

/** One host event, narrowed to the types in {@link EVENT_TYPES}. */
export type HostEvent = Stream.Success<HostEventStream>;

export interface ModelRefLike {
  readonly id?: string;
  readonly providerID?: string;
}

interface SessionDefaults {
  agent?: string;
  model?: ModelRefLike;
}

interface OpenStep {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: ModelRefLike;
  readonly startedAt: number;
}

/**
 * Stateful translator from the v2 event stream to the recorder.
 *
 * It exists because v2 splits what v1's single `message.updated` carried: the
 * model / agent / start time arrive on `session.step.started`, the cost and
 * tokens on `session.step.ended`. The bridge remembers the former so the latter
 * can be reassembled into the one `MessageInfo` the engine records — and it
 * remembers each session's last agent / model so the `prompt` hook, which
 * carries neither, can still attribute a prompt.
 *
 * Privacy: only sizes, ids and outcomes are forwarded. `session.text.ended`
 * hands the recorder the text solely so it can take `.length`; nothing here (or
 * in the recorder) retains it.
 */
export interface EventBridge {
  handle(event: HostEvent): void;
  /** Last-known agent / model for a session, from events and the `context` hook. */
  defaults(sessionID: string): SessionDefaults | undefined;
  /** Record the agent / model the `context` hook just saw. */
  noteContext(sessionID: string, agent: string | undefined, model: ModelRefLike | undefined): void;
  /** Pending-state size, for leak tests. */
  size(): { steps: number; sessions: number };
}

export function createEventBridge(deps: {
  recorder: TelemetryRecorder;
  logger: Logger;
  onBranch: (branch: string) => void;
}): EventBridge {
  const { recorder, logger } = deps;
  const steps = new Map<string, OpenStep>();
  const sessionDefaults = new Map<string, SessionDefaults>();

  const defaultsFor = (sessionID: string): SessionDefaults => {
    let entry = sessionDefaults.get(sessionID);
    if (!entry) {
      entry = {};
      sessionDefaults.set(sessionID, entry);
    }
    return entry;
  };

  const forward = (event: RecorderEvent): void => recorder.onEvent(event);

  const finishStep = (
    sessionID: string,
    assistantMessageID: string,
    completedAt: number,
    fields: {
      cost?: number;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
      finish?: string;
      error?: { type: string; status?: number };
    }
  ): void => {
    const step = steps.get(assistantMessageID);
    steps.delete(assistantMessageID);
    forward({
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          sessionID,
          role: "assistant",
          ...(step?.model.id ? { modelID: step.model.id } : {}),
          ...(step?.model.providerID ? { providerID: step.model.providerID } : {}),
          ...(step?.agent ? { mode: step.agent } : {}),
          ...(fields.cost !== undefined ? { cost: fields.cost } : {}),
          ...(fields.tokens ? { tokens: fields.tokens } : {}),
          time: { created: step?.startedAt ?? completedAt, completed: completedAt },
          ...(fields.finish ? { finish: fields.finish } : {}),
          ...(fields.error
            ? {
                error: {
                  name: fields.error.type,
                  data: {
                    ...(fields.error.status !== undefined
                      ? { statusCode: fields.error.status }
                      : {})
                  }
                }
              }
            : {})
        }
      }
    });
  };

  const dispatch = (event: HostEvent): void => {
    switch (event.type) {
      case "session.created": {
        const { data } = event;
        const entry = defaultsFor(data.sessionID);
        if (data.agent) {
          entry.agent = data.agent;
        }
        if (data.model) {
          entry.model = { id: data.model.id, providerID: data.model.providerID };
        }
        forward({
          type: "session.created",
          properties: {
            info: {
              id: data.sessionID,
              ...(data.parentID ? { parentID: data.parentID } : {}),
              directory: data.location.directory
            }
          }
        });
        return;
      }
      case "session.deleted": {
        const sessionID = event.data.sessionID;
        sessionDefaults.delete(sessionID);
        for (const [id, step] of steps) {
          if (step.sessionID === sessionID) {
            steps.delete(id);
          }
        }
        forward({ type: "session.deleted", properties: { info: { id: sessionID } } });
        return;
      }
      case "session.idle":
        forward({ type: "session.idle", properties: { sessionID: event.data.sessionID } });
        return;
      case "session.status": {
        const { status } = event.data;
        forward({
          type: "session.status",
          properties: {
            sessionID: event.data.sessionID,
            status: status.type === "retry" ? { type: "retry", attempt: status.attempt } : status
          }
        });
        return;
      }
      case "session.agent.selected":
        defaultsFor(event.data.sessionID).agent = event.data.agent;
        return;
      case "session.model.selected":
        defaultsFor(event.data.sessionID).model = {
          id: event.data.model.id,
          providerID: event.data.model.providerID
        };
        return;
      case "session.step.started": {
        const { data } = event;
        const model = { id: data.model.id, providerID: data.model.providerID };
        steps.set(data.assistantMessageID, {
          sessionID: data.sessionID,
          agent: data.agent,
          model,
          startedAt: data.started
        });
        const entry = defaultsFor(data.sessionID);
        entry.agent = data.agent;
        entry.model = model;
        // Open (and let the engine adopt the `context`-hook span for) the chat;
        // without `time.completed` the engine only registers it.
        forward({
          type: "message.updated",
          properties: {
            info: {
              id: data.assistantMessageID,
              sessionID: data.sessionID,
              role: "assistant",
              modelID: data.model.id,
              providerID: data.model.providerID,
              mode: data.agent,
              time: { created: data.started }
            }
          }
        });
        return;
      }
      case "session.step.ended": {
        const { data } = event;
        finishStep(data.sessionID, data.assistantMessageID, event.created, {
          cost: data.cost,
          tokens: data.tokens,
          finish: data.finish
        });
        return;
      }
      case "session.step.failed": {
        const { data } = event;
        finishStep(data.sessionID, data.assistantMessageID, event.created, {
          cost: data.cost,
          tokens: data.tokens,
          finish: data.finish,
          error: { type: data.error.type, status: data.error.status }
        });
        return;
      }
      case "session.compaction.ended":
        forward({ type: "session.compacted", properties: { sessionID: event.data.sessionID } });
        return;
      case "session.text.ended":
        recorder.onTextComplete(event.data.assistantMessageID, event.data.text);
        return;
      case "permission.asked":
        forward({
          type: "permission.updated",
          properties: {
            id: event.data.id,
            type: event.data.action,
            sessionID: event.data.sessionID
          }
        });
        return;
      case "permission.replied":
        forward({
          type: "permission.replied",
          properties: {
            sessionID: event.data.sessionID,
            permissionID: event.data.requestID,
            response: event.data.reply
          }
        });
        return;
      case "vcs.branch.updated":
        if (event.data.branch) {
          deps.onBranch(event.data.branch);
        }
        return;
      case "location.shutdown":
        // The host's real shutdown signal — flush and close before it exits.
        forward({ type: "server.instance.disposed" });
        return;
      default:
        return;
    }
  };

  return {
    handle(event) {
      try {
        dispatch(event);
      } catch (error) {
        // Telemetry must never break the host.
        logger.warn("otel_event_translation_failed", {
          type: (event as { type?: string } | undefined)?.type,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    defaults: (sessionID) => sessionDefaults.get(sessionID),
    noteContext(sessionID, agent, model) {
      const entry = defaultsFor(sessionID);
      if (agent) {
        entry.agent = agent;
      }
      if (model) {
        entry.model = model;
      }
    },
    size: () => ({ steps: steps.size, sessions: sessionDefaults.size })
  };
}
