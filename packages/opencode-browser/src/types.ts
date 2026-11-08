import type { ToolGroup } from "./schema.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type { ToolGroup } from "./schema.js";

/**
 * How the extension should drive the page. Mirrored into the extension, which
 * is where it actually takes effect; the plugin only forwards the preference so
 * the extension can default sensibly when its own setting is unset.
 *
 * - `"auto"`    — CDP (chrome.debugger) on Chromium when permitted, else content-script.
 * - `"cdp"`     — force the Chrome DevTools Protocol executor (Chromium only).
 * - `"content"` — force synthetic-event content-script executor (works on Firefox).
 */
export type ExecutorMode = "auto" | "cdp" | "content";

/**
 * Per-plugin configuration, delivered as `ctx.options` (the `options` of the
 * `plugins` entry). All
 * fields are optional; see DEFAULT_OPTIONS for the resolved defaults.
 */
export interface BrowserPluginOptions {
  /** Master switch. When false the bridge never starts and tools no-op-error. */
  enabled?: boolean;
  /** Interface to bind. Keep it loopback unless you really mean it. */
  host?: string;
  /** TCP port for the WebSocket bridge. */
  port?: number;
  /**
   * Shared secret the extension must present. If omitted, a random token is
   * generated at startup and logged once so it can be pasted into the extension.
   */
  token?: string;
  /** Forwarded executor preference (see ExecutorMode). */
  executor?: ExecutorMode;
  /**
   * Which tool groups to register: `page` (observe), `control` (drive),
   * `debug` (powerful/sensitive), `interactive` (ask the human on the page and
   * block on them). Defaults to `["page","control"]` — `debug` and
   * `interactive` are opt-in. Per-agent control is also possible via OpenCode's
   * tool allow/deny on the `browser_*` names.
   */
  groups?: ToolGroup[];
  /** Per-command timeout in ms before the tool call rejects. */
  timeoutMs?: number;
  /**
   * Directory screenshots are written to. Relative paths resolve against the
   * session worktree. Defaults to `.opencode/browser` under the worktree.
   */
  screenshotDir?: string;
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedBrowserOptions {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  executor: ExecutorMode;
  groups: ToolGroup[];
  timeoutMs: number;
  screenshotDir: string;
}

/**
 * Shape the extension returns for a `screenshot` command. The PNG travels as
 * base64 (no binary frames over the text protocol); the plugin decodes and
 * writes it to disk.
 */
export interface ScreenshotResult {
  /** Base64-encoded PNG bytes (no data: prefix). */
  base64: string;
  width: number;
  height: number;
  /**
   * True when `fullPage` was requested but the executor could only capture the
   * viewport (the content-script backend / Firefox can't capture beyond it).
   */
  partial?: boolean;
}
