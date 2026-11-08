/**
 * The recorder's input contract.
 *
 * `core-otel` is an engine, not a plugin: it registers no hooks and imports no
 * OpenCode plugin API. Everything the `TelemetryRecorder` reads is declared
 * here, as the minimal structural shapes it actually touches. The plugins that
 * feed it (`opencode-otel`, `opencode-lightbridge`) adapt the host's payloads
 * to these types — so this file, not the host's SDK, is what the engine is
 * versioned against.
 *
 * Hook payload fields deliberately use the OpenCode v2 names
 * (`@opencode/plugin` 2.x: `id` for the tool call id, `model.id`, `maxTokens`,
 * `status`) so that the adaptation is a field pick, not a rename. Every field
 * is optional unless the recorder cannot do its job without it.
 */

/** A `Model.Ref`, reduced to the two fields the recorder reads. */
export interface RecorderModelRef {
  readonly id?: string;
  readonly providerID?: string;
}

// ------------------------------------------------------------------ hooks

/** v2 source: `session.hook("prompt")` (`sessionID`), plus the resolved agent / model. */
export interface ChatMessageInput {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model?: RecorderModelRef;
}

/**
 * One piece of a user prompt. Only `type` and the length of `text` are read —
 * content is never captured. v2's `Prompt` is `{ text, files? }`; the adapter
 * flattens it to `[{ type: "text", text }, ...files.map(() => ({ type: "file" }))]`.
 */
export interface PromptPart {
  readonly type?: string;
  readonly text?: string;
}

export interface ChatMessageOutput {
  readonly parts?: ReadonlyArray<PromptPart>;
}

/** v2 source: `session.hook("context")` — `sessionID`, `agent`, `model`. */
export interface ChatParamsInput {
  readonly sessionID: string;
  readonly agent?: string;
  readonly model?: RecorderModelRef;
}

/** v2 source: `session.hook("context")` — `options` (`GenerationOptionsFields`). */
export interface ChatParamsOutput {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly maxTokens?: number;
}

/** v2 source: `tool.hook("execute.before")`. */
export interface ToolBeforeInput {
  readonly tool: string;
  readonly sessionID: string;
  /** The tool call id (`Tool.CallID`). */
  readonly id: string;
}

/** v2 source: `tool.hook("execute.after")`. A failing tool is reported here too. */
export interface ToolAfterInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly status: "completed" | "error";
}

/** A `Tool.Result` content part; only text parts have a measurable length. */
export interface ToolContentPart {
  readonly type?: string;
  readonly text?: string;
}

/**
 * v2 source: `execute.after`'s `result` (`Tool.Result`). Only the size of the
 * textual content is read, never the content itself.
 */
export interface ToolResultOutput {
  readonly content?: string | ReadonlyArray<ToolContentPart>;
}

/** v2 source: `permission.hook("evaluate")`. */
export interface PermissionAskInput {
  readonly sessionID: string;
  /**
   * The permission request id. v2's `evaluate` hook carries none (an
   * auto-decided request never produces a `permission.asked` event), so it is
   * optional; when present it de-duplicates against a later `permission.replied`.
   */
  readonly id?: string;
  /** The permission's subject: v1's `type`, v2's `action`. */
  readonly type: string;
}

/** v2 source: `evaluate`'s `effect` (`"allow" | "deny" | "ask"`). */
export interface PermissionAskOutput {
  readonly status?: string;
}

// ----------------------------------------------------------------- events

/** Error shape carried by `session.error` and by an assistant message's `error`. */
export interface SessionErrorInfo {
  readonly name?: string;
  readonly data?: { readonly statusCode?: number; readonly isRetryable?: boolean };
}

export interface SessionInfo {
  readonly id: string;
  readonly parentID?: string;
  readonly directory?: string;
}

export interface SessionStatusInfo {
  readonly type: string;
  readonly attempt?: number;
}

export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** A message as reported by `message.updated`; only assistant messages are recorded. */
export interface MessageInfo {
  readonly id: string;
  readonly sessionID: string;
  readonly role: string;
  readonly modelID?: string;
  readonly providerID?: string;
  readonly mode?: string;
  readonly cost?: number;
  readonly tokens?: TokenCounts;
  readonly time?: { readonly created: number; readonly completed?: number };
  readonly error?: SessionErrorInfo;
  readonly finish?: string;
}

/** A message part as reported by `message.part.updated`; only terminal tool parts are recorded. */
export interface PartInfo {
  readonly type: string;
  readonly callID?: string;
  readonly tool?: string;
  readonly sessionID?: string;
  readonly state?: {
    readonly status: string;
    readonly time?: { readonly start: number; readonly end?: number };
  };
}

/**
 * The engine's event vocabulary: the events `TelemetryRecorder.onEvent` reacts
 * to. This is the recorder's own contract — OpenCode v2 reports the same facts
 * under different event names and shapes (`{ type, data }` rather than
 * `{ type, properties }`), so the feeding plugin translates; see `docs/otel.md`
 * for the per-event v2 source table.
 */
export type RecorderEvent =
  | { readonly type: "session.created"; readonly properties: { readonly info: SessionInfo } }
  | { readonly type: "session.idle"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.status";
      readonly properties: { readonly sessionID: string; readonly status: SessionStatusInfo };
    }
  | { readonly type: "session.compacted"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.error";
      readonly properties: { readonly sessionID?: string; readonly error?: SessionErrorInfo };
    }
  | { readonly type: "message.updated"; readonly properties: { readonly info: MessageInfo } }
  | { readonly type: "message.part.updated"; readonly properties: { readonly part: PartInfo } }
  | {
      readonly type: "permission.updated";
      readonly properties: {
        readonly id: string;
        readonly type: string;
        readonly sessionID: string;
      };
    }
  | {
      readonly type: "permission.replied";
      readonly properties: {
        readonly sessionID: string;
        readonly permissionID: string;
        readonly response: string;
      };
    }
  | { readonly type: "installation.updated"; readonly properties: { readonly version: string } }
  | { readonly type: "vcs.branch.updated"; readonly properties: { readonly branch?: string } }
  | {
      readonly type: "session.deleted";
      readonly properties: { readonly info: { readonly id: string } };
    }
  | { readonly type: "server.instance.disposed" };
