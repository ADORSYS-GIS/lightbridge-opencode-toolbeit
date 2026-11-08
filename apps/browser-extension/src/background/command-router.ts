import { browser } from "wxt/browser";

import { recordAction, recordScreenshot } from "../shared/db";
import type { CommandFrame } from "../shared/protocol";
import type { Executor, Viewport } from "./executor";
import { startFeedback } from "./feedback";
import type { FeedbackMode, FeedbackRequest } from "./feedback-overlay";
import type { GroupRegistry } from "./group-registry";
import { runPageAction, type Target } from "./page-actions";

function target(params: Record<string, unknown>): Target {
  return {
    ref: params.ref as string | undefined,
    selector: params.selector as string | undefined,
    x: params.x as number | undefined,
    y: params.y as number | undefined
  };
}

/**
 * Translates a single `command` frame into registry / executor / page-action
 * calls and returns the `data` the plugin tool expects. Records every action
 * (and screenshot) to IndexedDB for the dashboard — including failures.
 */
export class CommandRouter {
  /**
   * Teardown callbacks for in-flight cancellable commands, keyed by command id.
   * Long-running interactive commands (e.g. a feedback overlay) register here so
   * a broker `cancel` can abort them; ordinary commands never register.
   */
  private readonly cancellers = new Map<string, () => void>();

  constructor(
    private readonly registry: GroupRegistry,
    private readonly executor: Executor
  ) {}

  /** Register a teardown for a cancellable command; returns a disposer. */
  registerCanceller(id: string, teardown: () => void): () => void {
    this.cancellers.set(id, teardown);
    return () => this.cancellers.delete(id);
  }

  /** Broker abandoned command `id` — run and drop its teardown if present. */
  cancel(id: string): void {
    const teardown = this.cancellers.get(id);
    if (!teardown) {
      return;
    }
    this.cancellers.delete(id);
    teardown();
  }

  async handle(frame: CommandFrame): Promise<unknown> {
    const start = Date.now();
    try {
      const { data, summary } = await this.dispatch(frame);
      await recordAction({
        ts: start,
        group: frame.group,
        action: frame.action,
        ok: true,
        summary,
        durationMs: Date.now() - start
      });
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordAction({
        ts: start,
        group: frame.group,
        action: frame.action,
        ok: false,
        summary: message,
        durationMs: Date.now() - start
      });
      throw err;
    } finally {
      // The command settled on its own; drop any teardown it registered.
      this.cancellers.delete(frame.id);
    }
  }

  private tab(group: string, params: Record<string, unknown>): number {
    return this.registry.resolveTab(group, params.tabId as number | undefined);
  }

  private async dispatch(frame: CommandFrame): Promise<{ data: unknown; summary: string }> {
    const { action, group, params } = frame;

    switch (action) {
      case "open": {
        const info = await this.registry.open(
          group,
          params.url as string | undefined,
          params.focus as boolean | undefined
        );
        return { data: info, summary: `opened ${info.url}` };
      }
      case "navigate": {
        const info = await this.registry.navigate(
          group,
          params.url as string,
          params.tabId as number | undefined
        );
        return { data: info, summary: `navigated to ${info.url}` };
      }
      case "back": {
        const info = await this.registry.back(group, params.tabId as number | undefined);
        return { data: info, summary: `back → ${info.url}` };
      }
      case "forward": {
        const info = await this.registry.forward(group, params.tabId as number | undefined);
        return { data: info, summary: `forward → ${info.url}` };
      }
      case "reload": {
        const info = await this.registry.reload(group, params.tabId as number | undefined);
        return { data: info, summary: `reloaded ${info.url}` };
      }
      case "activate": {
        const info = await this.registry.activate(group, params.tabId as number | undefined);
        return { data: info, summary: `activated tab ${info.tabId}` };
      }
      case "tabs": {
        const data = await this.registry.list((params.group as string | undefined) || undefined);
        return { data, summary: `listed ${data.groups.length} group(s)` };
      }
      case "close": {
        const data = await this.registry.close(group, params.tabId as number | undefined);
        return { data, summary: `closed ${data.closed.length} tab(s)` };
      }
      case "click": {
        await this.executor.click(
          this.tab(group, params),
          target(params),
          (params.button as "left" | "middle" | "right") ?? "left"
        );
        return { data: { ok: true }, summary: "clicked" };
      }
      case "double_click": {
        await this.executor.doubleClick(this.tab(group, params), target(params));
        return { data: { ok: true }, summary: "double-clicked" };
      }
      case "hover": {
        await this.executor.hover(this.tab(group, params), target(params));
        return { data: { ok: true }, summary: "hovered" };
      }
      case "drag": {
        const from: Target = {
          ref: params.fromRef as string | undefined,
          selector: params.fromSelector as string | undefined
        };
        await this.executor.drag(this.tab(group, params), from, target(params));
        return { data: { ok: true }, summary: "dragged" };
      }
      case "type": {
        await this.executor.type(
          this.tab(group, params),
          params.text as string,
          target(params),
          Boolean(params.submit)
        );
        return { data: { ok: true }, summary: `typed ${(params.text as string).length} chars` };
      }
      case "press_key": {
        await this.executor.pressKey(this.tab(group, params), params.key as string);
        return { data: { ok: true }, summary: `pressed ${params.key}` };
      }
      case "upload": {
        const paths = (params.paths as string[]) ?? [];
        await this.executor.upload(this.tab(group, params), target(params), paths);
        return { data: { ok: true }, summary: `uploaded ${paths.length} file(s)` };
      }
      case "fill": {
        const fields = params.fields as Array<{ ref?: string; selector?: string; value: string }>;
        const { filled } = await runPageAction<{ filled: number }>(
          this.tab(group, params),
          "fill",
          { fields }
        );
        return { data: { filled }, summary: `filled ${filled} field(s)` };
      }
      case "select": {
        const { ok } = await runPageAction<{ ok: boolean }>(this.tab(group, params), "select", {
          ref: params.ref,
          selector: params.selector,
          value: params.value,
          values: params.values
        });
        if (!ok) {
          throw new Error("select target not found or not a <select> element");
        }
        return { data: { ok }, summary: "selected" };
      }
      case "scroll": {
        const { ok } = await runPageAction<{ ok: boolean }>(this.tab(group, params), "scroll", {
          deltaX: params.deltaX,
          deltaY: params.deltaY,
          to: params.to,
          ref: params.ref,
          selector: params.selector
        });
        if (!ok) {
          throw new Error("scroll target element not found");
        }
        return { data: { ok }, summary: "scrolled" };
      }
      case "snapshot": {
        const data = await runPageAction(this.tab(group, params), "snapshot", { maxNodes: 200 });
        const refs = (data as { refs?: number }).refs ?? 0;
        return { data, summary: `snapshot (${refs} refs)` };
      }
      case "get_text": {
        const data = await runPageAction<{ text: string }>(this.tab(group, params), "getText");
        return { data, summary: `read ${data.text.length} chars` };
      }
      case "get_html": {
        const data = await runPageAction<{ found: boolean; html: string }>(
          this.tab(group, params),
          "getHtml",
          {
            ref: params.ref,
            selector: params.selector,
            outer: params.outer
          }
        );
        if (!data.found) {
          throw new Error("element not found for get_html");
        }
        return { data, summary: `read ${data.html.length} chars of HTML` };
      }
      case "get_attribute": {
        const data = await runPageAction<{ found: boolean }>(
          this.tab(group, params),
          "getAttribute",
          {
            ref: params.ref,
            selector: params.selector,
            name: params.name
          }
        );
        if (!data.found) {
          throw new Error("element not found for get_attribute");
        }
        return { data, summary: "read attributes" };
      }
      case "query": {
        const data = await runPageAction<{ count: number }>(this.tab(group, params), "query", {
          selector: params.selector,
          limit: params.limit
        });
        return { data, summary: `${data.count} match(es)` };
      }
      case "eval": {
        const data = await runPageAction(this.tab(group, params), "eval", { code: params.code });
        return { data, summary: "evaluated" };
      }
      case "console": {
        const entries = await this.executor.getConsole(this.tab(group, params));
        return { data: { entries }, summary: `${entries.length} console entr(ies)` };
      }
      case "network": {
        const entries = await this.executor.getNetwork(this.tab(group, params));
        return { data: { entries }, summary: `${entries.length} request(s)` };
      }
      case "handle_dialog": {
        await this.executor.handleDialog(
          this.tab(group, params),
          params.accept !== false,
          params.promptText as string | undefined
        );
        return { data: { ok: true }, summary: "handled dialog" };
      }
      case "set_viewport": {
        const viewport: Viewport = {
          width: Number(params.width),
          height: Number(params.height),
          mobile: params.mobile as boolean | undefined,
          deviceScaleFactor: params.deviceScaleFactor as number | undefined
        };
        await this.executor.setViewport(this.tab(group, params), viewport);
        return { data: { ok: true }, summary: `viewport ${viewport.width}×${viewport.height}` };
      }
      case "cookies":
        return this.cookies(params);
      case "wait": {
        if (typeof params.ms !== "number" && !params.selector) {
          throw new Error("wait requires either `ms` or `selector`");
        }
        const tabId = this.tab(group, params);
        if (typeof params.ms === "number") {
          await new Promise((r) => setTimeout(r, params.ms as number));
          return { data: { ok: true }, summary: `waited ${params.ms}ms` };
        }
        const state = (params.state as "visible" | "hidden" | "attached") ?? "visible";
        const { found } = await runPageAction<{ found: boolean }>(tabId, "waitForSelector", {
          selector: params.selector,
          state,
          timeoutMs: 10_000
        });
        if (!found) {
          throw new Error(`timed out waiting for ${params.selector} to be ${state}`);
        }
        return { data: { found }, summary: `waited for ${params.selector}` };
      }
      case "screenshot": {
        const shot = await this.executor.screenshot(
          this.tab(group, params),
          Boolean(params.fullPage)
        );
        await recordScreenshot({
          ts: Date.now(),
          group,
          dataUrl: `data:image/png;base64,${shot.base64}`,
          width: shot.width,
          height: shot.height
        });
        return { data: shot, summary: `screenshot ${shot.width}×${shot.height}` };
      }
      case "release": {
        await this.executor.releaseAll();
        return { data: { ok: true }, summary: "released control" };
      }
      case "request_feedback": {
        const tabId = this.tab(group, params);
        const req: FeedbackRequest = {
          mode: (params.mode as FeedbackMode) ?? "confirm",
          prompt: params.prompt as string | undefined,
          options: Array.isArray(params.options) ? (params.options as string[]) : undefined,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 120_000
        };
        const handle = startFeedback(tabId, frame.id, req);
        // Register before awaiting so a broker `cancel` mid-wait can tear it down.
        this.registerCanceller(frame.id, handle.cancel);
        const result = await handle.result;
        const summary = result.error
          ? `feedback unavailable: ${result.error}`
          : result.timedOut
            ? "feedback timed out"
            : result.responded
              ? `feedback: ${result.annotations.map((a) => a.kind).join(",") || "none"}`
              : "feedback dismissed";
        return { data: result, summary };
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }

  private async cookies(
    params: Record<string, unknown>
  ): Promise<{ data: unknown; summary: string }> {
    const op = String(params.op ?? "get");
    const url = params.url as string | undefined;
    const name = params.name as string | undefined;
    if (op === "set") {
      if (!url) {
        throw new Error("cookies set requires a url");
      }
      const cookie = await browser.cookies.set({
        url,
        name,
        value: params.value as string | undefined,
        domain: params.domain as string | undefined,
        path: params.path as string | undefined
      });
      return { data: { cookie }, summary: `set cookie ${name ?? ""}` };
    }
    if (op === "clear") {
      if (!url || !name) {
        throw new Error("cookies clear requires url and name");
      }
      await browser.cookies.remove({ url, name });
      return { data: { ok: true }, summary: `cleared cookie ${name}` };
    }
    // get / list
    const cookies = await browser.cookies.getAll({ url, name: op === "get" ? name : undefined });
    return { data: { cookies }, summary: `${cookies.length} cookie(s)` };
  }
}
