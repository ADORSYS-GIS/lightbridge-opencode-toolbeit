import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Hooks } from "@opencode-ai/plugin";

import { createInstruments, detectLanguage, type Instruments } from "./instruments.js";
import type { Logger } from "./logging.js";
import type { TelemetryProviders } from "./providers.js";
import type { ResolvedOtelConfig } from "./types.js";

type OpencodeEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type ChatMessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0];
type ChatMessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ToolBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0];
type ToolAfterInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0];
type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];
type TextCompleteInput = Parameters<NonNullable<Hooks["experimental.text.complete"]>>[0];
type PermissionAskInput = Parameters<NonNullable<Hooks["permission.ask"]>>[0];
type CompactionInput = Parameters<NonNullable<Hooks["experimental.compaction.autocontinue"]>>[0];

export interface RecorderDeps {
  providers: TelemetryProviders;
  config: ResolvedOtelConfig;
  logger: Logger;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Sinks for the two resource attributes OpenCode only reveals through
   * events (`installation.updated`, `vcs.branch.updated`). Without these the
   * recorder has nowhere to put them: a `Resource` is fixed at provider
   * construction, which happens before any event arrives.
   */
  resourceSinks?: {
    version?: (value: string) => void;
    branch?: (value: string) => void;
  };
}

interface SessionState {
  span?: Span;
  context: Context;
  startedAt: number;
  busySince?: number;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

interface ChatState {
  span?: Span;
  sessionID: string;
  /** Sampling parameters captured from `chat.params`, stamped when the span closes. */
  params?: Attributes;
}

interface ToolSpanState {
  span?: Span;
  tool: string;
  sessionID: string;
  startedAt: number;
}

/**
 * `diffs` is keyed by session *and* file. The separator is a NUL because it
 * cannot occur in either part — and it lives here, behind two functions,
 * because an invisible character duplicated across a writer and a reader is
 * exactly the kind of literal that silently stops matching.
 */
const DIFF_KEY_SEPARATOR = "\u0000";

function diffKey(sessionID: string, file: string): string {
  return `${sessionID}${DIFF_KEY_SEPARATOR}${file}`;
}

function diffKeyPrefix(sessionID: string): string {
  return `${sessionID}${DIFF_KEY_SEPARATOR}`;
}

/** Terminal tool outcomes, as reported by `ToolPart.state.status`. */
type ToolStatus = "ok" | "error";

/**
 * Translates the OpenCode event stream and hook callbacks into OTel signals.
 *
 * Deliberately holds no content: lengths, counts, durations and outcomes only.
 * See `plans/otel.md` → "No content capture in v1".
 */
export class TelemetryRecorder {
  private readonly instruments?: Instruments;
  private readonly now: () => number;

  private readonly sessions = new Map<string, SessionState>();
  private readonly chats = new Map<string, ChatState>();
  /**
   * Chats opened by `chat.params` but not yet matched to an assistant message.
   * `chat.params` fires *before* the provider request goes out, so without this
   * the very first request of a turn has no span to propagate trace context
   * from. Keyed by session; adopted by the next assistant message.
   */
  private readonly pendingChats = new Map<string, ChatState>();
  private readonly tools = new Map<string, ToolSpanState>();
  /** Completed assistant text length per message, from `experimental.text.complete`. */
  private readonly responseLengths = new Map<string, number>();
  /** Permissions already counted at `permission.ask` time, so a later reply cannot double-count. */
  private readonly autoDecided = new Set<string>();
  /**
   * Terminal tool outcomes already recorded, so the hook and the part update
   * cannot double-count. Keyed by call id, valued by session so the entry can
   * be pruned when that session ends.
   */
  private readonly finishedTools = new Map<string, string>();
  /**
   * Assistant messages already finalized — `message.updated` fires repeatedly
   * with cumulative totals. Valued by session, for pruning.
   */
  private readonly finalizedMessages = new Map<string, string>();
  /** Pending permission prompts, so `permission.replied` can name the tool it resolved. */
  private readonly permissions = new Map<string, { type: string; sessionID: string }>();
  /**
   * Last-seen cumulative diff per `sessionID\0file`. `session.diff` reports the
   * session's whole diff each time, so only the delta may be counted.
   */
  private readonly diffs = new Map<string, { additions: number; deletions: number }>();

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now;
    this.instruments = deps.providers.meter ? createInstruments(deps.providers.meter) : undefined;
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Session id as a *metric* attribute — omitted unless `includeSessionId`,
   * because it is unbounded cardinality and metric backends bill per series.
   * Logs and spans always carry it.
   */
  private metricSession(sessionID: string): Attributes {
    return this.deps.config.includeSessionId ? { "gen_ai.conversation.id": sessionID } : {};
  }

  private emit(
    name: string,
    attributes: Attributes,
    severity: SeverityNumber = SeverityNumber.INFO,
    context?: Context
  ): void {
    this.deps.providers.otelLogger?.emit({
      timestamp: this.now(),
      severityNumber: severity,
      severityText: severity >= SeverityNumber.ERROR ? "ERROR" : "INFO",
      body: name,
      attributes: { "event.name": name, ...attributes },
      context
    });
  }

  private session(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID);
    if (!state) {
      // A session we never saw created (the plugin loaded mid-session, or the
      // host replayed history) still gets a state so its metrics are not lost.
      state = {
        context: ROOT_CONTEXT,
        startedAt: this.now(),
        requests: 0,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0
      };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  // ----------------------------------------------------------------- events

  onEvent(event: OpencodeEvent): void {
    try {
      this.dispatch(event);
    } catch (error) {
      // Telemetry must never break the host. Swallow, but say so.
      this.deps.logger.warn("otel_event_failed", {
        type: (event as { type?: string })?.type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private dispatch(event: OpencodeEvent): void {
    switch (event.type) {
      case "session.created":
        this.onSessionCreated(event.properties.info);
        return;
      case "session.idle":
        this.onSessionIdle(event.properties.sessionID);
        return;
      case "session.status":
        this.onSessionStatus(event.properties.sessionID, event.properties.status);
        return;
      case "session.compacted":
        this.onCompacted(event.properties.sessionID);
        return;
      case "session.error":
        this.onSessionError(event.properties.sessionID, event.properties.error);
        return;
      case "session.diff":
        this.onSessionDiff(event.properties.sessionID, event.properties.diff);
        return;
      case "message.updated":
        this.onMessageUpdated(event.properties.info);
        return;
      case "message.part.updated":
        this.onPartUpdated(event.properties.part);
        return;
      case "permission.updated":
        this.permissions.set(event.properties.id, {
          type: event.properties.type,
          sessionID: event.properties.sessionID
        });
        return;
      case "permission.replied":
        this.onPermissionReplied(
          event.properties.sessionID,
          event.properties.permissionID,
          event.properties.response
        );
        return;
      case "command.executed":
        this.onCommandExecuted(
          event.properties.sessionID,
          event.properties.name,
          event.properties.arguments
        );
        return;
      case "installation.updated":
        // The only channel the host version arrives on. See `deferred.ts`.
        this.deps.resourceSinks?.version?.(event.properties.version);
        return;
      case "vcs.branch.updated":
        if (event.properties.branch) {
          this.deps.resourceSinks?.branch?.(event.properties.branch);
        }
        return;
      case "todo.updated":
        this.onTodoUpdated(event.properties.sessionID, event.properties.todos);
        return;
      case "session.deleted":
        this.forgetSession(event.properties.info.id);
        return;
      case "server.instance.disposed":
        // A real shutdown signal from the host — more reliable than waiting for
        // a process signal that a supervised runtime may never deliver.
        void this.shutdown().catch(() => {
          /* best-effort */
        });
        return;
      default:
        return;
    }
  }

  private onSessionCreated(info: { id: string; parentID?: string; directory?: string }): void {
    const kind = info.parentID ? "child" : "root";
    const startedAt = this.now();

    const span = this.deps.providers.tracer?.startSpan(
      "invoke_agent opencode",
      {
        kind: SpanKind.INTERNAL,
        startTime: startedAt,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "opencode",
          "gen_ai.conversation.id": info.id,
          "opencode.session.kind": kind
        }
      },
      ROOT_CONTEXT
    );

    const context = span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT;
    this.sessions.set(info.id, {
      span,
      context,
      startedAt,
      requests: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0
    });

    this.instruments?.sessions.add(1, {
      "opencode.session.kind": kind,
      ...this.metricSession(info.id)
    });
    this.emit(
      "opencode.session_start",
      {
        "gen_ai.conversation.id": info.id,
        "opencode.session.kind": kind,
        ...(info.parentID ? { "opencode.session.parent_id": info.parentID } : {}),
        ...(info.directory ? { "opencode.directory": info.directory } : {})
      },
      SeverityNumber.INFO,
      context
    );
  }

  private onSessionStatus(sessionID: string, status: { type: string; attempt?: number }): void {
    const state = this.session(sessionID);
    if (status.type === "busy") {
      state.busySince ??= this.now();
      return;
    }
    if (status.type === "retry") {
      this.emit(
        "opencode.api_error",
        {
          "gen_ai.conversation.id": sessionID,
          "error.type": "retry",
          "opencode.error.retryable": true,
          ...(typeof status.attempt === "number"
            ? { "opencode.retry.attempt": status.attempt }
            : {})
        },
        SeverityNumber.WARN,
        state.context
      );
      return;
    }
    this.settleActiveTime(sessionID, state);
  }

  private settleActiveTime(sessionID: string, state: SessionState): void {
    if (state.busySince === undefined) {
      return;
    }
    const seconds = Math.max(0, (this.now() - state.busySince) / 1000);
    state.busySince = undefined;
    this.instruments?.activeTime.add(seconds, this.metricSession(sessionID));
  }

  private onSessionIdle(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (!state) {
      return;
    }
    this.settleActiveTime(sessionID, state);

    this.emit(
      "opencode.session_idle",
      {
        "gen_ai.conversation.id": sessionID,
        "opencode.session.duration_ms": this.now() - state.startedAt,
        "opencode.session.request_count": state.requests,
        "opencode.cost.usage": state.cost,
        "gen_ai.usage.input_tokens": state.inputTokens,
        "gen_ai.usage.output_tokens": state.outputTokens
      },
      SeverityNumber.INFO,
      state.context
    );

    if (state.span) {
      state.span.setAttribute("opencode.session.request_count", state.requests);
      state.span.setAttribute("opencode.cost.usage", state.cost);
      state.span.end();
    }
    this.sessions.delete(sessionID);
    // A turn ended: the dedupe bookkeeping for its finished messages and tools
    // is dead weight from here on. `diffs` deliberately survives — the session
    // may resume, and its diff totals are cumulative.
    this.pruneCompleted(sessionID);

    // A short CLI invocation may exit right after idle, so drain now rather
    // than waiting for the batch interval.
    void this.deps.providers.forceFlush().catch(() => {
      /* best-effort */
    });
  }

  private onCompacted(sessionID: string): void {
    const state = this.session(sessionID);
    this.instruments?.compactions.add(1, this.metricSession(sessionID));
    this.deps.providers.tracer
      ?.startSpan("session_compaction", { startTime: this.now() }, state.context)
      .end();
    this.emit(
      "opencode.compaction",
      { "gen_ai.conversation.id": sessionID },
      SeverityNumber.INFO,
      state.context
    );
  }

  private onSessionError(sessionID: string | undefined, error: unknown): void {
    const named = error as { name?: string; data?: { statusCode?: number; isRetryable?: boolean } };
    const state = sessionID ? this.session(sessionID) : undefined;
    this.emit(
      "opencode.api_error",
      {
        ...(sessionID ? { "gen_ai.conversation.id": sessionID } : {}),
        "error.type": named?.name ?? "UnknownError",
        ...(typeof named?.data?.statusCode === "number"
          ? { "http.response.status_code": named.data.statusCode }
          : {}),
        ...(typeof named?.data?.isRetryable === "boolean"
          ? { "opencode.error.retryable": named.data.isRetryable }
          : {})
      },
      SeverityNumber.ERROR,
      state?.context
    );
  }

  private onSessionDiff(
    sessionID: string,
    diff: Array<{ file: string; additions: number; deletions: number }>
  ): void {
    const state = this.session(sessionID);
    for (const entry of diff) {
      const key = diffKey(sessionID, entry.file);
      const previous = this.diffs.get(key) ?? { additions: 0, deletions: 0 };
      // Cumulative source → count only what is new since the last report.
      const added = Math.max(0, (entry.additions ?? 0) - previous.additions);
      const removed = Math.max(0, (entry.deletions ?? 0) - previous.deletions);
      this.diffs.set(key, {
        additions: entry.additions ?? 0,
        deletions: entry.deletions ?? 0
      });
      if (added === 0 && removed === 0) {
        continue;
      }

      const language = detectLanguage(entry.file);
      const languageAttr = language ? { "code.language": language } : {};
      if (added > 0) {
        this.instruments?.linesOfCode.add(added, {
          "opencode.change.type": "added",
          ...languageAttr,
          ...this.metricSession(sessionID)
        });
      }
      if (removed > 0) {
        this.instruments?.linesOfCode.add(removed, {
          "opencode.change.type": "removed",
          ...languageAttr,
          ...this.metricSession(sessionID)
        });
      }
      this.emit(
        "opencode.file_edited",
        {
          "gen_ai.conversation.id": sessionID,
          ...languageAttr,
          "opencode.file.additions": added,
          "opencode.file.deletions": removed
        },
        SeverityNumber.INFO,
        state.context
      );
    }
  }

  private onMessageUpdated(info: unknown): void {
    const message = info as {
      id: string;
      sessionID: string;
      role: string;
      modelID?: string;
      providerID?: string;
      mode?: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
      time?: { created: number; completed?: number };
      error?: { name?: string; data?: { statusCode?: number; isRetryable?: boolean } };
      finish?: string;
    };
    if (message.role !== "assistant" || this.finalizedMessages.has(message.id)) {
      return;
    }

    const session = this.session(message.sessionID);
    const baseAttributes: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.conversation.id": message.sessionID,
      ...(message.modelID ? { "gen_ai.request.model": message.modelID } : {}),
      ...(message.providerID ? { "gen_ai.provider.name": message.providerID } : {}),
      ...(message.mode ? { "gen_ai.agent.name": message.mode } : {})
    };

    let chat = this.chats.get(message.id);
    if (!chat) {
      // Adopt the span `chat.params` opened for this session, if there is one —
      // it started before the provider request went out, so it covers the whole
      // round-trip rather than only the part after the response began arriving.
      const pending = this.pendingChats.get(message.sessionID);
      if (pending) {
        this.pendingChats.delete(message.sessionID);
        pending.span?.updateName(`chat ${message.modelID ?? "unknown"}`);
        pending.span?.setAttributes(baseAttributes);
        chat = pending;
      } else {
        chat = {
          sessionID: message.sessionID,
          span: this.deps.providers.tracer?.startSpan(
            `chat ${message.modelID ?? "unknown"}`,
            {
              kind: SpanKind.CLIENT,
              startTime: message.time?.created ?? this.now(),
              attributes: baseAttributes
            },
            session.context
          )
        };
      }
      this.chats.set(message.id, chat);
    }

    if (message.time?.completed === undefined) {
      return;
    }
    this.finalizeMessage(message, chat, session, baseAttributes);
  }

  private finalizeMessage(
    message: {
      id: string;
      sessionID: string;
      modelID?: string;
      providerID?: string;
      mode?: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
      time?: { created: number; completed?: number };
      error?: { name?: string; data?: { statusCode?: number; isRetryable?: boolean } };
      finish?: string;
    },
    chat: ChatState,
    session: SessionState,
    baseAttributes: Attributes
  ): void {
    this.finalizedMessages.set(message.id, message.sessionID);
    this.chats.delete(message.id);
    const responseLength = this.responseLengths.get(message.id);
    this.responseLengths.delete(message.id);

    const created = message.time?.created ?? this.now();
    const completed = message.time?.completed ?? this.now();
    const durationSeconds = Math.max(0, (completed - created) / 1000);
    const errorType = message.error?.name;

    const metricAttributes: Attributes = {
      "gen_ai.operation.name": "chat",
      ...(message.modelID ? { "gen_ai.request.model": message.modelID } : {}),
      ...(message.providerID ? { "gen_ai.provider.name": message.providerID } : {}),
      ...(message.mode ? { "gen_ai.agent.name": message.mode } : {}),
      ...this.metricSession(message.sessionID)
    };

    // Real USD, straight from the host — no price table to drift out of date.
    const cost = typeof message.cost === "number" ? message.cost : 0;
    if (cost > 0) {
      this.instruments?.cost.add(cost, metricAttributes);
    }

    const tokens = message.tokens;
    if (tokens) {
      const byType: Array<[string, number]> = [
        ["input", tokens.input],
        ["output", tokens.output],
        ["reasoning", tokens.reasoning],
        ["cache_read", tokens.cache?.read ?? 0],
        ["cache_write", tokens.cache?.write ?? 0]
      ];
      for (const [type, value] of byType) {
        // Cache and reasoning tokens are recorded as first-class types: on a
        // cached agentic session cache-read is routinely the majority of
        // tokens, so summing input+output alone measures the wrong thing.
        if (typeof value === "number" && value > 0) {
          this.instruments?.tokens.record(value, {
            ...metricAttributes,
            "gen_ai.token.type": type
          });
        }
      }
    }

    this.instruments?.requests.add(1, metricAttributes);
    this.instruments?.duration.record(durationSeconds, {
      ...metricAttributes,
      ...(errorType ? { "error.type": errorType } : {})
    });

    session.requests += 1;
    session.cost += cost;
    session.inputTokens += tokens?.input ?? 0;
    session.outputTokens += tokens?.output ?? 0;

    const usageAttributes: Attributes = {
      ...baseAttributes,
      "gen_ai.usage.input_tokens": tokens?.input ?? 0,
      "gen_ai.usage.output_tokens": tokens?.output ?? 0,
      "gen_ai.usage.reasoning_tokens": tokens?.reasoning ?? 0,
      "gen_ai.usage.cache_read_tokens": tokens?.cache?.read ?? 0,
      "gen_ai.usage.cache_write_tokens": tokens?.cache?.write ?? 0,
      "opencode.cost.usage": cost,
      "opencode.response.duration_ms": completed - created,
      // Size of the assistant's text, never the text itself.
      ...(responseLength !== undefined ? { "opencode.response.length": responseLength } : {}),
      ...(chat.params ?? {}),
      ...(message.finish ? { "gen_ai.response.finish_reasons": [message.finish] } : {}),
      ...(errorType ? { "error.type": errorType } : {})
    };

    if (chat.span) {
      chat.span.setAttributes(usageAttributes);
      if (errorType) {
        chat.span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
      }
      chat.span.end(completed);
    }

    this.emit(
      "opencode.assistant_response",
      usageAttributes,
      errorType ? SeverityNumber.ERROR : SeverityNumber.INFO,
      session.context
    );

    if (message.error) {
      this.onSessionError(message.sessionID, message.error);
    }
  }

  private onPartUpdated(part: unknown): void {
    const typed = part as {
      type: string;
      callID?: string;
      tool?: string;
      sessionID?: string;
      state?: { status: string; time?: { start: number; end?: number } };
    };
    if (typed.type !== "tool" || !typed.callID || !typed.state) {
      return;
    }
    const status = typed.state.status;
    if (status !== "completed" && status !== "error") {
      return;
    }
    const time = typed.state.time;
    const durationMs =
      time?.end !== undefined && time?.start !== undefined
        ? Math.max(0, time.end - time.start)
        : undefined;
    this.finishTool(typed.callID, {
      tool: typed.tool ?? "unknown",
      sessionID: typed.sessionID ?? "",
      status: status === "error" ? "error" : "ok",
      durationMs
    });
  }

  private onPermissionReplied(sessionID: string, permissionID: string, response: string): void {
    // Already counted at `permission.ask` time as an auto-decision.
    if (this.autoDecided.delete(permissionID)) {
      return;
    }
    const pending = this.permissions.get(permissionID);
    this.permissions.delete(permissionID);
    this.recordDecision(sessionID, permissionID, response, "user", pending?.type);
  }

  private recordDecision(
    sessionID: string,
    permissionID: string,
    decision: string,
    source: "user" | "auto",
    tool?: string
  ): void {
    const state = this.session(sessionID);
    const toolAttr = tool ? { "gen_ai.tool.name": tool } : {};

    this.instruments?.permissionDecisions.add(1, {
      "opencode.permission.decision": decision,
      "opencode.permission.source": source,
      ...toolAttr,
      ...this.metricSession(sessionID)
    });
    this.emit(
      "opencode.tool_decision",
      {
        "gen_ai.conversation.id": sessionID,
        "opencode.permission.decision": decision,
        "opencode.permission.source": source,
        "opencode.permission.id": permissionID,
        ...toolAttr
      },
      SeverityNumber.INFO,
      state.context
    );
  }

  /**
   * Drop every per-session entry. Without this the bookkeeping sets grow for
   * the life of the process — fine for a CLI invocation, a slow leak in a
   * long-running OpenCode server.
   */
  private forgetSession(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (state) {
      this.settleActiveTime(sessionID, state);
      state.span?.end();
      this.sessions.delete(sessionID);
    }
    this.pendingChats.get(sessionID)?.span?.end();
    this.pendingChats.delete(sessionID);

    for (const [id, chat] of this.chats) {
      if (chat.sessionID === sessionID) {
        chat.span?.end();
        this.chats.delete(id);
      }
    }
    for (const [callID, tool] of this.tools) {
      if (tool.sessionID === sessionID) {
        tool.span?.end();
        this.tools.delete(callID);
      }
    }
    for (const key of this.diffs.keys()) {
      if (key.startsWith(diffKeyPrefix(sessionID))) {
        this.diffs.delete(key);
      }
    }
    for (const [id, permission] of this.permissions) {
      if (permission.sessionID === sessionID) {
        this.permissions.delete(id);
        this.autoDecided.delete(id);
      }
    }
    this.pruneCompleted(sessionID);
  }

  /**
   * Drop the dedupe bookkeeping for a session's finished messages and tool
   * calls. Safe to run at every idle — those ids are never reused, so nothing
   * can be double-counted afterwards. Deliberately does **not** touch `diffs`:
   * `session.diff` is cumulative, so forgetting the last-seen totals for a
   * session that later resumes would re-count its whole diff.
   */
  private pruneCompleted(sessionID: string): void {
    for (const [id, owner] of this.finalizedMessages) {
      if (owner === sessionID) {
        this.finalizedMessages.delete(id);
        this.responseLengths.delete(id);
      }
    }
    for (const [callID, owner] of this.finishedTools) {
      if (owner === sessionID) {
        this.finishedTools.delete(callID);
      }
    }
  }

  private onCommandExecuted(sessionID: string, name: string, args?: string): void {
    const state = this.session(sessionID);
    this.instruments?.commands.add(1, {
      "opencode.command.name": name,
      ...this.metricSession(sessionID)
    });
    this.emit(
      "opencode.command_executed",
      {
        "gen_ai.conversation.id": sessionID,
        "opencode.command.name": name,
        // Whether arguments were passed, never what they were.
        "opencode.command.has_arguments": Boolean(args && args.trim() !== "")
      },
      SeverityNumber.INFO,
      state.context
    );
  }

  private onTodoUpdated(sessionID: string, todos: Array<{ status?: string }>): void {
    const state = this.session(sessionID);
    const byStatus: Record<string, number> = {};
    for (const todo of todos ?? []) {
      const status = todo?.status ?? "unknown";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    this.emit(
      "opencode.todo_updated",
      {
        "gen_ai.conversation.id": sessionID,
        "opencode.todo.total": todos?.length ?? 0,
        ...Object.fromEntries(
          Object.entries(byStatus).map(([status, count]) => [`opencode.todo.${status}`, count])
        )
      },
      SeverityNumber.INFO,
      state.context
    );
  }

  // ------------------------------------------------------------------ hooks

  onChatMessage(input: ChatMessageInput, output: ChatMessageOutput): void {
    const session = this.session(input.sessionID);
    const parts = output?.parts ?? [];
    // Length, not content — see the no-content-capture decision.
    let promptLength = 0;
    const partTypes: Record<string, number> = {};
    for (const part of parts) {
      const typed = part as { type?: string; text?: string };
      const type = typed.type ?? "unknown";
      partTypes[type] = (partTypes[type] ?? 0) + 1;
      if (typeof typed.text === "string") {
        promptLength += typed.text.length;
      }
    }

    this.emit(
      "opencode.user_prompt",
      {
        "gen_ai.conversation.id": input.sessionID,
        "opencode.prompt.length": promptLength,
        "opencode.prompt.part_count": parts.length,
        ...Object.fromEntries(
          Object.entries(partTypes).map(([type, count]) => [`opencode.prompt.parts.${type}`, count])
        ),
        ...(input.agent ? { "gen_ai.agent.name": input.agent } : {}),
        ...(input.model?.modelID ? { "gen_ai.request.model": input.model.modelID } : {}),
        ...(input.model?.providerID ? { "gen_ai.provider.name": input.model.providerID } : {})
      },
      SeverityNumber.INFO,
      session.context
    );
  }

  /**
   * `chat.params` runs immediately before the provider request. Opening the
   * `chat` span here rather than at the first `message.updated` is what makes
   * trace-context propagation work at all for the first request of a turn —
   * otherwise the fetch happens while no chat span exists.
   */
  onChatParams(input: ChatParamsInput, output: ChatParamsOutput): void {
    const session = this.session(input.sessionID);
    const model = input.model as { id?: string; modelID?: string } | undefined;
    const modelId = model?.id ?? model?.modelID;

    const params: Attributes = {};
    const numeric: Array<[string, unknown]> = [
      ["gen_ai.request.temperature", output?.temperature],
      ["gen_ai.request.top_p", output?.topP],
      ["gen_ai.request.top_k", output?.topK],
      ["gen_ai.request.max_tokens", output?.maxOutputTokens]
    ];
    for (const [key, value] of numeric) {
      if (typeof value === "number" && Number.isFinite(value)) {
        params[key] = value;
      }
    }

    // A previous pending span for this session means the last request never
    // produced an assistant message (aborted, or errored before streaming).
    this.pendingChats.get(input.sessionID)?.span?.end();

    this.pendingChats.set(input.sessionID, {
      sessionID: input.sessionID,
      params,
      span: this.deps.providers.tracer?.startSpan(
        `chat ${modelId ?? "unknown"}`,
        {
          kind: SpanKind.CLIENT,
          startTime: this.now(),
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.conversation.id": input.sessionID,
            ...(modelId ? { "gen_ai.request.model": modelId } : {}),
            ...(input.agent ? { "gen_ai.agent.name": input.agent } : {}),
            ...params
          }
        },
        session.context
      )
    });
  }

  /** Assistant text finished streaming — record its size, never its content. */
  onTextComplete(input: TextCompleteInput, output: { text?: string }): void {
    if (typeof output?.text !== "string") {
      return;
    }
    const previous = this.responseLengths.get(input.messageID) ?? 0;
    this.responseLengths.set(input.messageID, previous + output.text.length);
  }

  /**
   * Every permission evaluation passes through here, including the ones config
   * auto-resolves. Only an already-decided prompt is counted now — an `ask`
   * waits for `permission.replied`, so the two paths never double-count. Without
   * this hook, auto-allowed permissions were invisible and the decision counter
   * silently undercounted.
   */
  onPermissionAsk(input: PermissionAskInput, output: { status?: string }): void {
    const decision = output?.status;
    if (!decision || decision === "ask") {
      return;
    }
    this.autoDecided.add(input.id);
    this.recordDecision(input.sessionID, input.id, decision, "auto", input.type);
  }

  /** Compaction finished — `overflow` says whether the context forced it. */
  onCompactionAutocontinue(input: CompactionInput, output: { enabled?: boolean }): void {
    const state = this.session(input.sessionID);
    this.emit(
      "opencode.compaction_autocontinue",
      {
        "gen_ai.conversation.id": input.sessionID,
        "opencode.compaction.overflow": Boolean(input.overflow),
        "opencode.compaction.autocontinue_enabled": output?.enabled !== false,
        ...(input.agent ? { "gen_ai.agent.name": input.agent } : {})
      },
      SeverityNumber.INFO,
      state.context
    );
  }

  onToolBefore(input: ToolBeforeInput): void {
    const session = this.session(input.sessionID);
    const filtered = this.deps.config.filteredTools.has(input.tool);
    this.tools.set(input.callID, {
      tool: input.tool,
      sessionID: input.sessionID,
      startedAt: this.now(),
      // Filtered tools still produce metrics; they just skip the span, which is
      // what keeps a `read`-heavy session's trace readable.
      span: filtered
        ? undefined
        : this.deps.providers.tracer?.startSpan(
            `execute_tool ${input.tool}`,
            {
              kind: SpanKind.INTERNAL,
              startTime: this.now(),
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": input.tool,
                "gen_ai.tool.call.id": input.callID,
                "gen_ai.conversation.id": input.sessionID
              }
            },
            session.context
          )
    });
  }

  onToolAfter(input: ToolAfterInput, output: { output?: string }): void {
    this.finishTool(input.callID, {
      tool: input.tool,
      sessionID: input.sessionID,
      status: "ok",
      outputSize: typeof output?.output === "string" ? output.output.length : undefined
    });
  }

  /**
   * Record a tool's terminal outcome exactly once. Both `tool.execute.after`
   * and the tool part reaching a terminal state report it, and which arrives
   * depends on whether the tool succeeded — first writer wins, so a failing
   * tool (no `after` hook) is still counted.
   */
  private finishTool(
    callID: string,
    outcome: {
      tool: string;
      sessionID: string;
      status: ToolStatus;
      durationMs?: number;
      outputSize?: number;
    }
  ): void {
    if (this.finishedTools.has(callID)) {
      return;
    }

    const started = this.tools.get(callID);
    this.tools.delete(callID);
    const tool = started?.tool ?? outcome.tool;
    const sessionID = started?.sessionID || outcome.sessionID;
    this.finishedTools.set(callID, sessionID);
    const durationMs =
      outcome.durationMs ?? (started ? Math.max(0, this.now() - started.startedAt) : undefined);

    this.instruments?.toolInvocations.add(1, {
      "gen_ai.tool.name": tool,
      "opencode.tool.status": outcome.status,
      ...this.metricSession(sessionID)
    });

    const attributes: Attributes = {
      "gen_ai.tool.name": tool,
      "gen_ai.tool.call.id": callID,
      "opencode.tool.status": outcome.status,
      ...(sessionID ? { "gen_ai.conversation.id": sessionID } : {}),
      ...(durationMs !== undefined ? { "opencode.tool.duration_ms": durationMs } : {}),
      ...(outcome.outputSize !== undefined
        ? { "opencode.tool.output.size": outcome.outputSize }
        : {})
    };

    if (started?.span) {
      started.span.setAttributes(attributes);
      if (outcome.status === "error") {
        started.span.setStatus({ code: SpanStatusCode.ERROR });
      }
      started.span.end();
    }

    this.emit(
      "opencode.tool_result",
      attributes,
      outcome.status === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
      sessionID ? this.session(sessionID).context : undefined
    );
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * The context of the single in-flight chat, or `undefined` when zero or more
   * than one is running. Ambiguity yields no trace context rather than a wrong
   * parent — a missing link is recoverable, a fabricated one is not.
   */
  currentChatContext(): Context | undefined {
    // A pending chat (opened by `chat.params`) counts: that is precisely the
    // window in which the provider request is actually made.
    const live = [...this.pendingChats.values(), ...this.chats.values()];
    if (live.length !== 1) {
      return undefined;
    }
    const [chat] = live;
    return chat?.span ? trace.setSpan(ROOT_CONTEXT, chat.span) : undefined;
  }

  /**
   * Sizes of the in-memory bookkeeping. Exposed because these maps are the only
   * unbounded thing the plugin holds — a long-running OpenCode server that
   * never emitted `session.deleted` is exactly where a leak would show up, and
   * "how big is it" should be answerable without a heap dump.
   */
  pendingStateSize(): Record<string, number> {
    return {
      sessions: this.sessions.size,
      chats: this.chats.size,
      pendingChats: this.pendingChats.size,
      tools: this.tools.size,
      finalizedMessages: this.finalizedMessages.size,
      finishedTools: this.finishedTools.size,
      permissions: this.permissions.size,
      diffs: this.diffs.size
    };
  }

  async shutdown(): Promise<void> {
    for (const [sessionID, state] of this.sessions) {
      this.settleActiveTime(sessionID, state);
      state.span?.end();
    }
    this.sessions.clear();
    for (const chat of [...this.chats.values(), ...this.pendingChats.values()]) {
      chat.span?.end();
    }
    this.chats.clear();
    this.pendingChats.clear();
    for (const tool of this.tools.values()) {
      tool.span?.end();
    }
    this.tools.clear();
    await this.deps.providers.shutdown();
  }
}
