import { CdpSession, KEY_CODES } from "./cdp";
import {
  cdpModifierMask,
  type ConsoleEntry,
  type Executor,
  type NetworkEntry,
  parseChord,
  type ScreenshotData,
  targetToSelector,
  type Viewport
} from "./executor";
import { type Center, runPageAction, type Target } from "./page-actions";

interface LayoutMetrics {
  cssContentSize?: { width: number; height: number };
  cssVisualViewport?: { clientWidth: number; clientHeight: number };
}

/** Executor backed by the Chrome DevTools Protocol — trusted input + full-page capture. */
export class CdpExecutor implements Executor {
  readonly kind = "cdp" as const;
  private readonly cdp = new CdpSession();

  /** Resolve a target to viewport coordinates, preferring explicit x/y. */
  private async resolveCenter(tabId: number, target: Target): Promise<Center> {
    if (typeof target.x === "number" && typeof target.y === "number") {
      return { found: true, x: target.x, y: target.y };
    }
    const center = await runPageAction<Center>(tabId, "getCenter", { ...target });
    if (!center?.found) {
      throw new Error("could not locate the target element");
    }
    return center;
  }

  private async mouse(
    tabId: number,
    x: number,
    y: number,
    button: "left" | "middle" | "right",
    clickCount: number
  ): Promise<void> {
    const base = { x, y, button, clickCount };
    const buttonsBit = button === "right" ? 2 : button === "middle" ? 4 : 1;
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      buttons: buttonsBit,
      ...base
    });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      buttons: 0,
      ...base
    });
  }

  async click(tabId: number, target: Target, button: "left" | "middle" | "right"): Promise<void> {
    await this.cdp.attach(tabId);
    const { x, y } = await this.resolveCenter(tabId, target);
    await this.mouse(tabId, x, y, button, 1);
  }

  async doubleClick(tabId: number, target: Target): Promise<void> {
    await this.cdp.attach(tabId);
    const { x, y } = await this.resolveCenter(tabId, target);
    await this.mouse(tabId, x, y, "left", 1);
    await this.mouse(tabId, x, y, "left", 2);
  }

  async hover(tabId: number, target: Target): Promise<void> {
    await this.cdp.attach(tabId);
    const { x, y } = await this.resolveCenter(tabId, target);
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async drag(tabId: number, from: Target, to: Target): Promise<void> {
    await this.cdp.attach(tabId);
    const a = await this.resolveCenter(tabId, from);
    const b = await this.resolveCenter(tabId, to);
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: a.x,
      y: a.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: b.x,
      y: b.y,
      button: "left",
      buttons: 1
    });
    await this.cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: b.x,
      y: b.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  }

  async type(tabId: number, text: string, target: Target, submit: boolean): Promise<void> {
    await this.cdp.attach(tabId);
    if (target.ref || target.selector || (target.x !== undefined && target.y !== undefined)) {
      const { x, y } = await this.resolveCenter(tabId, target);
      await this.mouse(tabId, x, y, "left", 1); // focus the field
    }
    const { editable } = await runPageAction<{ editable: boolean }>(tabId, "activeEditable");
    if (!editable) {
      throw new Error("target is not a text-editable element");
    }
    await this.cdp.send(tabId, "Input.insertText", { text });
    if (submit) {
      await this.pressKey(tabId, "Enter");
    }
  }

  async pressKey(tabId: number, key: string): Promise<void> {
    await this.cdp.attach(tabId);
    const { modifiers, key: baseKey } = parseChord(key);
    const mask = cdpModifierMask(modifiers);
    const descriptor = KEY_CODES[baseKey];
    const single = baseKey.length === 1;
    const common = descriptor
      ? { key: baseKey, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode }
      : {
          key: baseKey,
          windowsVirtualKeyCode: single ? baseKey.toUpperCase().charCodeAt(0) : undefined
        };
    await this.cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: mask,
      ...common
    });
    if (!descriptor && single && mask === 0) {
      await this.cdp.send(tabId, "Input.dispatchKeyEvent", { type: "char", text: baseKey });
    }
    await this.cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: mask,
      ...common
    });
  }

  async screenshot(tabId: number, fullPage: boolean): Promise<ScreenshotData> {
    await this.cdp.attach(tabId);
    const metrics = await this.cdp.send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
    const params: Record<string, unknown> = { format: "png", captureBeyondViewport: fullPage };
    let width = metrics.cssVisualViewport?.clientWidth ?? 1280;
    let height = metrics.cssVisualViewport?.clientHeight ?? 800;
    if (fullPage && metrics.cssContentSize) {
      width = metrics.cssContentSize.width;
      height = metrics.cssContentSize.height;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const result = await this.cdp.send<{ data: string }>(tabId, "Page.captureScreenshot", params);
    return { base64: result.data, width: Math.round(width), height: Math.round(height) };
  }

  async upload(tabId: number, target: Target, paths: string[]): Promise<void> {
    await this.cdp.attach(tabId);
    const selector = targetToSelector(target);
    if (!selector) {
      throw new Error("upload needs a ref or selector for the file <input>");
    }
    const doc = await this.cdp.send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", {
      depth: 0
    });
    const found = await this.cdp.send<{ nodeId: number }>(tabId, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector
    });
    if (!found.nodeId) {
      throw new Error("file input not found");
    }
    await this.cdp.send(tabId, "DOM.setFileInputFiles", { nodeId: found.nodeId, files: paths });
  }

  async eval(tabId: number, code: string): Promise<{ result: unknown }> {
    await this.cdp.attach(tabId);
    // Runtime.evaluate runs in the page's main world with no CSP restriction
    // (unlike the content-script `globalThis.eval` fallback), and returns the
    // value serialized via `returnByValue`.
    const res = await this.cdp.send<{
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      result?: { type: string; subtype?: string; value?: unknown; description?: string };
    }>(tabId, "Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`eval threw: ${d.exception?.description ?? d.text ?? "unknown exception"}`);
    }
    const r = res.result;
    if (r?.subtype === "error") {
      throw new Error(`eval threw: ${r.description ?? r.type}`);
    }
    return { result: r?.value ?? null };
  }

  async setViewport(tabId: number, viewport: Viewport): Promise<void> {
    await this.cdp.attach(tabId);
    await this.cdp.send(tabId, "Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 0,
      mobile: Boolean(viewport.mobile)
    });
  }

  async getConsole(tabId: number): Promise<ConsoleEntry[]> {
    await this.cdp.attach(tabId);
    return this.cdp.getConsole(tabId);
  }

  async getNetwork(tabId: number): Promise<NetworkEntry[]> {
    await this.cdp.attach(tabId);
    return this.cdp.getNetwork(tabId);
  }

  async handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
    await this.cdp.attach(tabId);
    await this.cdp.send(tabId, "Page.handleJavaScriptDialog", { accept, promptText });
  }

  async release(tabId: number): Promise<void> {
    await this.cdp.detach(tabId);
  }

  async releaseAll(): Promise<void> {
    await this.cdp.detachAll();
  }
}
