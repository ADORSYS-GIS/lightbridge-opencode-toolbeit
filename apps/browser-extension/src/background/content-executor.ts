import { browser } from "wxt/browser";

import type { ConsoleEntry, Executor, NetworkEntry, ScreenshotData } from "./executor";
import { captureFullPage } from "./full-page";
import { runInPage, runPageAction, type Target } from "./page-actions";

const CDP_ONLY = (feature: string) =>
  new Error(
    `${feature} requires the CDP executor (Chromium with the debugger) — not available on the content-script backend`
  );

/**
 * Fallback executor: synthetic DOM events injected into the page plus
 * `tabs.captureVisibleTab` (+ scroll-stitch for full-page). No "being debugged"
 * banner and works on Firefox, but clicks aren't trusted (`isTrusted: false`)
 * and the CDP-only capabilities below are unavailable.
 */
export class ContentExecutor implements Executor {
  readonly kind = "content" as const;

  async click(tabId: number, target: Target, button: "left" | "middle" | "right"): Promise<void> {
    const { ok } = await runPageAction<{ ok: boolean }>(tabId, "pointer", {
      ...target,
      button,
      dblclick: false
    });
    if (!ok) {
      throw new Error("could not locate the target element");
    }
  }

  async doubleClick(tabId: number, target: Target): Promise<void> {
    const { ok } = await runPageAction<{ ok: boolean }>(tabId, "pointer", {
      ...target,
      dblclick: true
    });
    if (!ok) {
      throw new Error("could not locate the target element");
    }
  }

  async hover(tabId: number, target: Target): Promise<void> {
    const { ok } = await runPageAction<{ ok: boolean }>(tabId, "hover", { ...target });
    if (!ok) {
      throw new Error("could not locate the target element");
    }
  }

  async drag(tabId: number, from: Target, to: Target): Promise<void> {
    const { ok } = await runPageAction<{ ok: boolean }>(tabId, "drag", {
      from: { ref: from.ref, selector: from.selector },
      ref: to.ref,
      selector: to.selector
    });
    if (!ok) {
      throw new Error("could not locate the drag source or target");
    }
  }

  async type(tabId: number, text: string, target: Target, submit: boolean): Promise<void> {
    const { ok } = await runPageAction<{ ok: boolean }>(tabId, "type", {
      text,
      ref: target.ref,
      selector: target.selector,
      submit
    });
    if (!ok) {
      throw new Error("no text-editable element to type into");
    }
  }

  async pressKey(tabId: number, key: string): Promise<void> {
    await runPageAction(tabId, "key", { key });
  }

  async screenshot(tabId: number, fullPage: boolean): Promise<ScreenshotData> {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) {
      throw new Error("tab has no window");
    }
    // captureVisibleTab grabs the active tab of the window — make sure it's ours.
    // Activation + paint is async, so wait briefly or we'd capture the prior tab.
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (fullPage) {
      return captureFullPage(tabId, tab.windowId);
    }
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    const size = await runInPage(
      tabId,
      () => ({ w: window.innerWidth, h: window.innerHeight }),
      []
    );
    return { base64, width: size?.w ?? 0, height: size?.h ?? 0 };
  }

  async upload(): Promise<void> {
    throw CDP_ONLY("browser_upload");
  }

  async setViewport(): Promise<void> {
    throw CDP_ONLY("browser_set_viewport");
  }

  async getConsole(): Promise<ConsoleEntry[]> {
    throw CDP_ONLY("browser_console");
  }

  async getNetwork(): Promise<NetworkEntry[]> {
    throw CDP_ONLY("browser_network");
  }

  async handleDialog(): Promise<void> {
    throw CDP_ONLY("browser_handle_dialog");
  }

  async release(_tabId: number): Promise<void> {
    // Nothing to release — no persistent attachment.
  }

  async releaseAll(): Promise<void> {
    // No persistent attachments.
  }
}
