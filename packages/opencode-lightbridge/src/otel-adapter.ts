import type {
  ChatMessageInput,
  ChatMessageOutput,
  ChatParamsInput,
  ChatParamsOutput,
  MessageInfo,
  PermissionAskInput,
  PermissionAskOutput,
  RecorderEvent,
  ToolAfterInput,
  ToolBeforeInput,
  ToolResultOutput
} from "@vymalo/opencode-core-otel/lib";

/**
 * v2 -> `core-otel` adapter (ADR-0019). `TelemetryRecorder` is an engine with
 * its own input vocabulary (`recorder-input.ts`); OpenCode v2 reports the same
 * facts under different event names and a `{ type, data }` shape. This file is
 * the whole translation, kept pure (no Effect, no host types) so it is testable
 * without a host: the plugin only subscribes and forwards.
 *
 * The host payloads are read defensively (`unknown` in, narrowed per field) —
 * a malformed or future-shaped event is skipped, never thrown: telemetry must
 * not break the host.
 */

/** A host event, as delivered by `ctx.event.subscribe()`. */
export interface HostEvent {
  readonly type: string;
  /** Event time (epoch ms), when the host provides it. */
  readonly created?: number;
  readonly data?: unknown;
}

/** The recorder surface the adapter drives. */
export interface RecorderSink {
  onEvent(event: RecorderEvent): void;
  onTextComplete(messageID: string, text: string): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface StepState {
  modelID?: string;
  providerID?: string;
  agent?: string;
  created: number;
}

function tokenCounts(value: unknown): MessageInfo["tokens"] {
  const tokens = record(value);
  const cache = record(tokens?.cache);
  if (!tokens) {
    return undefined;
  }
  return {
    input: num(tokens.input) ?? 0,
    output: num(tokens.output) ?? 0,
    reasoning: num(tokens.reasoning) ?? 0,
    cache: { read: num(cache?.read) ?? 0, write: num(cache?.write) ?? 0 }
  };
}

/** Stateful only for the step bookkeeping (model + start time) the end event lacks. */
export class OtelEventAdapter {
  private readonly steps = new Map<string, StepState>();

  constructor(
    private readonly sink: RecorderSink,
    private readonly now: () => number = Date.now
  ) {}

  /** Translate one host event; unknown types are ignored. */
  handle(event: HostEvent): void {
    const data = record(event.data);
    switch (event.type) {
      case "session.created": {
        const sessionID = str(data?.sessionID);
        if (!sessionID) {
          return;
        }
        this.sink.onEvent({
          type: "session.created",
          properties: {
            info: {
              id: sessionID,
              parentID: str(data?.parentID),
              directory: str(record(data?.location)?.directory)
            }
          }
        });
        return;
      }
      case "session.deleted": {
        const sessionID = str(data?.sessionID);
        if (sessionID) {
          this.sink.onEvent({ type: "session.deleted", properties: { info: { id: sessionID } } });
        }
        return;
      }
      case "session.step.started":
        this.stepStarted(data, event.created);
        return;
      case "session.step.ended":
        this.stepFinished(data, event.created, false);
        return;
      case "session.step.failed":
        this.stepFinished(data, event.created, true);
        return;
      case "session.text.ended": {
        const id = str(data?.assistantMessageID);
        const text = typeof data?.text === "string" ? data.text : undefined;
        if (id && text !== undefined) {
          this.sink.onTextComplete(id, text);
        }
        return;
      }
      case "session.retry.scheduled": {
        const sessionID = str(data?.sessionID);
        if (sessionID) {
          this.sink.onEvent({
            type: "session.status",
            properties: {
              sessionID,
              status: { type: "retry", attempt: num(data?.attempt) }
            }
          });
        }
        return;
      }
      case "session.compaction.ended": {
        const sessionID = str(data?.sessionID);
        if (sessionID) {
          this.sink.onEvent({ type: "session.compacted", properties: { sessionID } });
        }
        return;
      }
      case "session.execution.failed": {
        const sessionID = str(data?.sessionID);
        if (!sessionID) {
          return;
        }
        const error = record(data?.error);
        this.sink.onEvent({
          type: "session.error",
          properties: {
            sessionID,
            error: { name: str(error?.type), data: { statusCode: num(error?.status) } }
          }
        });
        this.sink.onEvent({ type: "session.idle", properties: { sessionID } });
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted": {
        // The turn boundary: v1's `session.idle` (the recorder flushes here).
        const sessionID = str(data?.sessionID);
        if (sessionID) {
          this.sink.onEvent({ type: "session.idle", properties: { sessionID } });
        }
        return;
      }
      case "permission.asked": {
        const id = str(data?.id);
        const sessionID = str(data?.sessionID);
        const type = str(data?.action);
        if (id && sessionID && type) {
          this.sink.onEvent({ type: "permission.updated", properties: { id, type, sessionID } });
        }
        return;
      }
      case "permission.replied": {
        const sessionID = str(data?.sessionID);
        const permissionID = str(data?.requestID);
        const response = str(data?.reply);
        if (sessionID && permissionID && response) {
          this.sink.onEvent({
            type: "permission.replied",
            properties: { sessionID, permissionID, response }
          });
        }
        return;
      }
      case "vcs.branch.updated":
        this.sink.onEvent({
          type: "vcs.branch.updated",
          properties: { branch: str(data?.branch) }
        });
        return;
      case "installation.updated": {
        const version = str(data?.version);
        if (version) {
          this.sink.onEvent({ type: "installation.updated", properties: { version } });
        }
        return;
      }
      default:
        return;
    }
  }

  private stepStarted(
    data: Record<string, unknown> | undefined,
    created: number | undefined
  ): void {
    const id = str(data?.assistantMessageID);
    const sessionID = str(data?.sessionID);
    if (!id || !sessionID) {
      return;
    }
    const model = record(data?.model);
    const state: StepState = {
      modelID: str(model?.id),
      providerID: str(model?.providerID),
      agent: str(data?.agent),
      created: num(data?.started) ?? created ?? this.now()
    };
    this.steps.set(id, state);
    this.sink.onEvent({
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "assistant",
          modelID: state.modelID,
          providerID: state.providerID,
          mode: state.agent,
          time: { created: state.created }
        }
      }
    });
  }

  private stepFinished(
    data: Record<string, unknown> | undefined,
    created: number | undefined,
    failed: boolean
  ): void {
    const id = str(data?.assistantMessageID);
    const sessionID = str(data?.sessionID);
    if (!id || !sessionID) {
      return;
    }
    const state = this.steps.get(id);
    this.steps.delete(id);
    const completed = created ?? this.now();
    const error = failed ? record(data?.error) : undefined;
    this.sink.onEvent({
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "assistant",
          modelID: state?.modelID,
          providerID: state?.providerID,
          mode: state?.agent,
          cost: num(data?.cost),
          tokens: tokenCounts(data?.tokens),
          finish: failed ? "error" : str(data?.finish),
          error: error
            ? { name: str(error.type), data: { statusCode: num(error.status) } }
            : undefined,
          time: { created: state?.created ?? completed, completed }
        }
      }
    });
  }
}

// ----------------------------------------------------------------- hooks

function modelRef(value: unknown): { id?: string; providerID?: string } | undefined {
  const model = record(value);
  return model ? { id: str(model.id), providerID: str(model.providerID) } : undefined;
}

/** `session.hook("prompt")`: flatten `Prompt { text, files }` to recorder parts. */
export function adaptPrompt(event: {
  sessionID: string;
  prompt: unknown;
  agent?: unknown;
  model?: unknown;
}): [ChatMessageInput, ChatMessageOutput] {
  const prompt = record(event.prompt);
  const files = Array.isArray(prompt?.files) ? prompt.files : [];
  return [
    { sessionID: event.sessionID, agent: str(event.agent), model: modelRef(event.model) },
    {
      parts: [
        { type: "text", text: typeof prompt?.text === "string" ? prompt.text : "" },
        ...files.map(() => ({ type: "file" }))
      ]
    }
  ];
}

/** `session.hook("context")`: sampling parameters from `options`. */
export function adaptContext(event: {
  sessionID: string;
  agent?: unknown;
  model?: unknown;
  options?: unknown;
}): [ChatParamsInput, ChatParamsOutput] {
  const options = record(event.options);
  return [
    { sessionID: event.sessionID, agent: str(event.agent), model: modelRef(event.model) },
    {
      temperature: num(options?.temperature),
      topP: num(options?.topP),
      topK: num(options?.topK),
      maxTokens: num(options?.maxTokens)
    }
  ];
}

export function adaptToolBefore(event: {
  tool: string;
  sessionID: string;
  id: string;
}): ToolBeforeInput {
  return { tool: event.tool, sessionID: event.sessionID, id: event.id };
}

/** `tool.hook("execute.after")`: the result's text content only, never read for meaning. */
export function adaptToolAfter(event: {
  tool: string;
  sessionID: string;
  id: string;
  status: "completed" | "error";
  result?: unknown;
}): [ToolAfterInput, ToolResultOutput | undefined] {
  const result = record(event.result);
  const content = result?.content;
  const output: ToolResultOutput | undefined =
    typeof content === "string" || Array.isArray(content)
      ? { content: content as ToolResultOutput["content"] }
      : undefined;
  return [
    { tool: event.tool, sessionID: event.sessionID, id: event.id, status: event.status },
    output
  ];
}

/** `permission.hook("evaluate")`: `action` becomes `type`, `effect` becomes `status`. */
export function adaptPermission(event: {
  sessionID: string;
  action: string;
  effect: string;
}): [PermissionAskInput, PermissionAskOutput] {
  return [{ sessionID: event.sessionID, type: event.action }, { status: event.effect }];
}
