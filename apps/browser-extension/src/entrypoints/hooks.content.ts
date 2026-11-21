import { defineContentScript } from "#imports";
import { browser } from "wxt/browser";

/**
 * Page-world hooks, installed before the page's own scripts run.
 *
 * A `document_start` content script lives in the isolated world, but Firefox
 * exposes the page's real objects through `window.wrappedJSObject`, and
 * `exportFunction` makes our replacements callable from the page. Assigning
 * these directly (unlike injecting a <script> tag) is not blocked by the page's
 * CSP, so console output from the very first inline script is captured.
 *
 * Records stay in this script's closure; the background asks for them with
 * `tabs.sendMessage` (see background/page-hooks.ts).
 */

interface ConsoleEntry {
  level: string;
  text: string;
  ts: number;
}

interface DialogEntry {
  type: "alert" | "confirm" | "prompt";
  message: string;
  ts: number;
  handled: boolean;
}

interface Recorded {
  console: ConsoleEntry[];
  dialogs: DialogEntry[];
}

const MAX_ENTRIES = 500;
const READ_MESSAGE = "ocb:hooks:read";
const HANDLED_MESSAGE = "ocb:hooks:handled";

declare const exportFunction: <T>(fn: T, target: unknown) => T;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  main() {
    const page = (window as unknown as { wrappedJSObject?: Record<string, unknown> })
      .wrappedJSObject;
    // Chrome has no wrappedJSObject (it drives pages through CDP instead).
    if (!page || typeof exportFunction !== "function" || page.__ocbHook) {
      return;
    }
    page.__ocbHook = true;

    const rec: Recorded = { console: [], dialogs: [] };

    const push = (list: unknown[], value: unknown): void => {
      list.push(value);
      if (list.length > MAX_ENTRIES) {
        list.shift();
      }
    };
    const stringify = (value: unknown): string => {
      if (typeof value === "string") {
        return value;
      }
      try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
      } catch {
        try {
          return String(value);
        } catch {
          return "[unserializable]";
        }
      }
    };
    const noteDialog = (type: DialogEntry["type"], message: unknown, answer: string): void => {
      const text = stringify(message ?? "");
      push(rec.dialogs, { type, message: text, ts: Date.now(), handled: false });
      push(rec.console, {
        level: "warn",
        text: `[dialog:${type}${answer}] ${text}`,
        ts: Date.now()
      });
    };

    const pageConsole = page.console as Record<string, (...args: unknown[]) => void>;
    for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
      const original = pageConsole[level];
      if (typeof original !== "function") {
        continue;
      }
      pageConsole[level] = exportFunction(function patched(...args: unknown[]): unknown {
        try {
          push(rec.console, {
            level,
            text: args.map(stringify).join(" ").slice(0, 2000),
            ts: Date.now()
          });
        } catch {
          /* never break the page for logging */
        }
        try {
          return original.apply(pageConsole, args);
        } catch {
          // The page's console may be an Xray wrapper that rejects `apply` from
          // this realm — recording is what matters, never break the caller.
          return undefined;
        }
      }, page);
    }

    const target = page as unknown as {
      alert: (message?: unknown) => void;
      confirm: (message?: unknown) => boolean;
      prompt: (message?: unknown, value?: string) => string | null;
      addEventListener: (type: string, listener: (event: unknown) => void) => void;
    };

    target.alert = exportFunction((message?: unknown): void => {
      noteDialog("alert", message, "");
    }, page);
    target.confirm = exportFunction((message?: unknown): boolean => {
      noteDialog("confirm", message, " → false");
      return false;
    }, page);
    target.prompt = exportFunction((message?: unknown): string | null => {
      noteDialog("prompt", message, " → null");
      return null;
    }, page);

    target.addEventListener("error", (event: unknown) => {
      const e = event as { message?: string; filename?: string; lineno?: number; colno?: number };
      try {
        push(rec.console, {
          level: "error",
          text: `${e.message ?? "error"} @ ${e.filename ?? ""}:${e.lineno ?? 0}:${e.colno ?? 0}`.slice(
            0,
            2000
          ),
          ts: Date.now()
        });
      } catch {
        /* ignore */
      }
    });
    target.addEventListener("unhandledrejection", (event: unknown) => {
      const e = event as { reason?: unknown };
      try {
        push(rec.console, {
          level: "error",
          text: `unhandledrejection: ${stringify(e.reason)}`.slice(0, 2000),
          ts: Date.now()
        });
      } catch {
        /* ignore */
      }
    });

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === READ_MESSAGE) {
        sendResponse({ console: rec.console, dialogs: rec.dialogs });
        return true;
      }
      if (type === HANDLED_MESSAGE) {
        for (const dialog of rec.dialogs) {
          dialog.handled = true;
        }
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }
});
