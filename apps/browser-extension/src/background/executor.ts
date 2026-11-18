import type { ExecutorKind, ExecutorMode } from "../shared/types";
import type { Target } from "./page-actions";

export interface ScreenshotData {
  base64: string;
  width: number;
  height: number;
  /** True when a full-page capture was requested but only the viewport was grabbed. */
  partial?: boolean;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  type?: string;
  ts: number;
}

export interface Viewport {
  width: number;
  height: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
}

/**
 * The trusted-input surface that genuinely differs between backends. Everything
 * else (snapshot, text, scroll, fill, select, wait) is DOM-only and handled
 * uniformly via page-actions, so it isn't part of this interface.
 */
export interface Executor {
  readonly kind: ExecutorKind;
  click(tabId: number, target: Target, button: "left" | "middle" | "right"): Promise<void>;
  doubleClick(tabId: number, target: Target): Promise<void>;
  type(tabId: number, text: string, target: Target, submit: boolean): Promise<void>;
  pressKey(tabId: number, key: string): Promise<void>;
  hover(tabId: number, target: Target): Promise<void>;
  drag(tabId: number, from: Target, to: Target): Promise<void>;
  screenshot(tabId: number, fullPage: boolean): Promise<ScreenshotData>;
  /** Set a file input's files. CDP-only — the content executor throws. */
  upload(tabId: number, target: Target, paths: string[]): Promise<void>;
  /**
   * Evaluate JavaScript in the page's main world and return the
   * JSON-serializable result. CDP-only — the content executor throws (the
   * content-script fallback's `globalThis.eval` is blocked by the MV3
   * isolated-world CSP on Chromium).
   */
  eval(tabId: number, code: string): Promise<{ result: unknown }>;
  /** Emulate a viewport. CDP-only — the content executor throws. */
  setViewport(tabId: number, viewport: Viewport): Promise<void>;
  /** Recent console output. CDP-only — the content executor throws. */
  getConsole(tabId: number): Promise<ConsoleEntry[]>;
  /** Recent network requests. CDP-only — the content executor throws. */
  getNetwork(tabId: number): Promise<NetworkEntry[]>;
  /** Accept/dismiss a pending JS dialog. CDP-only — the content executor throws. */
  handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<void>;
  /** Release any per-tab resources (e.g. detach the debugger). Best-effort. */
  release(tabId: number): Promise<void>;
  /** Release everything — called before the executor is torn down/replaced. */
  releaseAll(): Promise<void>;
}

export interface BrowserCapabilities {
  /** chrome.debugger present (Chromium). */
  hasDebugger: boolean;
}

export function detectCapabilities(): BrowserCapabilities {
  return {
    hasDebugger: typeof chrome !== "undefined" && typeof chrome.debugger?.attach === "function"
  };
}

/**
 * Decide which executor to use from the configured mode and the browser's
 * capabilities. Pure and total — unit-tested.
 *
 * - `auto`    → CDP when the debugger is available, else content-script.
 * - `cdp`     → CDP (falls back to content if the debugger is missing, so a
 *               Firefox user who forced `cdp` still gets a working executor).
 * - `content` → always content-script.
 */
export function resolveExecutorKind(mode: ExecutorMode, caps: BrowserCapabilities): ExecutorKind {
  if (mode === "content") {
    return "content";
  }
  if (mode === "cdp") {
    return caps.hasDebugger ? "cdp" : "content";
  }
  return caps.hasDebugger ? "cdp" : "content";
}

export interface ChordModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedChord {
  modifiers: ChordModifiers;
  key: string;
}

/**
 * Split a key chord like `"Control+a"` / `"Meta+Shift+p"` into its modifiers and
 * the final key. A lone `"+"` (or any single char) is treated as the key itself.
 * Pure and total — unit-tested.
 */
export function parseChord(input: string): ParsedChord {
  const modifiers: ChordModifiers = { ctrl: false, alt: false, shift: false, meta: false };
  if (input.length <= 1) {
    return { modifiers, key: input };
  }
  const parts = input.split("+");
  const key = parts.pop() ?? "";
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "ctrl":
      case "control":
        modifiers.ctrl = true;
        break;
      case "alt":
      case "option":
        modifiers.alt = true;
        break;
      case "shift":
        modifiers.shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
      case "super":
        modifiers.meta = true;
        break;
    }
  }
  return { modifiers, key };
}

/** CDP `Input.dispatchKeyEvent` modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
export function cdpModifierMask(m: ChordModifiers): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

/** Map a target to a CSS selector, or null for coordinate/active-element targeting. */
export function targetToSelector(target: Target): string | null {
  if (target.ref) {
    return `[data-ocb-ref="${target.ref}"]`;
  }
  if (target.selector) {
    return target.selector;
  }
  return null;
}
