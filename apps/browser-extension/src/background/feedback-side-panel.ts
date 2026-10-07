/**
 * Side-panel fallback for `interactive` feedback. When the in-page overlay can't
 * be injected (restricted / CSP page), we capture a screenshot of the tab and
 * route the request to the extension's own side panel instead — the panel can't
 * be blocked by the page. Cross-browser: Chromium `chrome.sidePanel`, Firefox
 * `sidebarAction`; neither can be force-opened without a user gesture, so we
 * enable it + raise the badge and the user opens it from the toolbar.
 *
 * The panel reads the pending request via `feedback:get-pending` and posts the
 * answer with the same `ocb-feedback-result` shape the overlay uses, so the
 * background's per-request listener correlates both surfaces identically.
 */
import { browser } from "wxt/browser";

import type { FeedbackSession } from "../shared/messages";

/** The single in-flight side-panel request (one at a time keeps the UX simple). */
let activeSession: FeedbackSession | null = null;
let activeTabId: number | null = null;

/** The request the side panel should render right now, if any. */
export function getActiveFeedbackSession(): FeedbackSession | null {
  return activeSession;
}

// Minimal structural views of the two browsers' panel APIs (the @types differ
// per target, so we narrow through `unknown` rather than depend on either).
interface SidePanelApi {
  setOptions(opts: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
}
interface SidebarActionApi {
  setPanel(details: { panel: string }): Promise<void> | void;
}
const sidePanelApi = (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel;
const sidebarActionApi = (browser as unknown as { sidebarAction?: SidebarActionApi }).sidebarAction;

const SIDE_PANEL_PATH = "sidepanel.html";

function broadcastPendingChanged(): void {
  // No receiver (panel closed) rejects — that's fine, the panel queries on open.
  browser.runtime.sendMessage({ type: "feedback:pending-changed" }).catch(() => {});
}

/**
 * Set up the side-panel fallback for a request: activate + screenshot the tab,
 * stash the session, and enable the panel. Returns true if the panel path is
 * ready (caller keeps waiting for the user); false if it couldn't be set up
 * (caller should settle with an error).
 */
export async function openSidePanelFallback(
  tabId: number,
  id: string,
  req: { mode: string; prompt?: string; options?: string[] }
): Promise<boolean> {
  if (!sidePanelApi && !sidebarActionApi) {
    return false;
  }
  let screenshot: string;
  try {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    return false; // can't even screenshot (e.g. a blocked page) — let caller error out
  }

  activeSession = { id, mode: req.mode, prompt: req.prompt, options: req.options, screenshot };
  activeTabId = tabId;

  try {
    if (sidePanelApi) {
      await sidePanelApi.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true });
      // While a request is pending, clicking the toolbar icon opens the panel
      // (restored to the normal popup behavior in clearFeedbackSession). We
      // can't open the panel ourselves — it needs the user's click.
      await sidePanelApi.setPanelBehavior?.({ openPanelOnActionClick: true });
    } else if (sidebarActionApi) {
      await sidebarActionApi.setPanel({ panel: chrome.runtime.getURL(SIDE_PANEL_PATH) });
    }
  } catch {
    activeSession = null;
    activeTabId = null;
    return false;
  }

  broadcastPendingChanged();
  return true;
}

/** Clear the session for `id` (on answer / timeout / cancel) and notify the panel. */
export function clearFeedbackSession(id: string): void {
  if (activeSession?.id !== id) {
    return;
  }
  const tabId = activeTabId;
  activeSession = null;
  activeTabId = null;
  // Restore the toolbar's normal popup behavior and retire the panel.
  if (sidePanelApi) {
    void sidePanelApi.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
    if (tabId !== null) {
      void sidePanelApi.setOptions({ tabId, enabled: false }).catch(() => {});
    }
  }
  broadcastPendingChanged();
}
