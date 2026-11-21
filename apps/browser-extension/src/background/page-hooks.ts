/**
 * Background side of the page hooks. The actual recording happens in the
 * `hooks.content` entrypoint, which runs at `document_start` so page scripts
 * are covered from their first line; this module only talks to it.
 *
 * `tabs.sendMessage` fails when no content script is present (privileged pages,
 * or a tab opened before the extension loaded), so callers get a clear error
 * instead of a silent empty list.
 */
import { browser } from "wxt/browser";

export interface PageConsoleEntry {
  level: string;
  text: string;
  ts: number;
}

export interface PageDialogEntry {
  type: "alert" | "confirm" | "prompt";
  message: string;
  ts: number;
  handled: boolean;
}

interface HookState {
  console: PageConsoleEntry[];
  dialogs: PageDialogEntry[];
}

const READ_MESSAGE = "ocb:hooks:read";
const HANDLED_MESSAGE = "ocb:hooks:handled";

const NO_HOOKS =
  "page hooks are not available in this tab — Firefox 128+ is required, and privileged pages (about:, addons.mozilla.org) do not allow content scripts";

async function ask(tabId: number, type: string): Promise<HookState | null> {
  try {
    const response = (await browser.tabs.sendMessage(tabId, { type })) as HookState | undefined;
    return response ?? null;
  } catch {
    return null;
  }
}

export async function readConsole(tabId: number): Promise<PageConsoleEntry[]> {
  const state = await ask(tabId, READ_MESSAGE);
  if (!state) {
    throw new Error(NO_HOOKS);
  }
  return state.console ?? [];
}

export async function readDialogs(tabId: number): Promise<PageDialogEntry[]> {
  const state = await ask(tabId, READ_MESSAGE);
  if (!state) {
    throw new Error(NO_HOOKS);
  }
  return state.dialogs ?? [];
}

export async function markDialogsHandled(tabId: number): Promise<void> {
  await ask(tabId, HANDLED_MESSAGE);
}
