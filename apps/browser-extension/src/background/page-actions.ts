/**
 * Page-side logic, injected via `scriptingApi().executeScript({ func })`.
 *
 * IMPORTANT: an injected function is serialized with `Function.prototype.toString`
 * and re-evaluated in the page — it has **no access to module scope**. So all the
 * DOM helpers and every action live inside the single self-contained
 * `pageDispatch` below; callers use `runPageAction(tabId, action, params)`.
 *
 * Both executors share this for DOM-bound work. The CDP executor additionally
 * uses trusted CDP input for click/type/key/hover/drag; the content executor
 * routes those to the synthetic-event branches here.
 */

import { scriptingApi } from "../lib/browser-apis";

export interface Target {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
}

export interface Center {
  found: boolean;
  x: number;
  y: number;
}

export interface SnapshotResult {
  snapshot: string;
  refs: number;
}

/** Run a self-contained function in the page and return its result. */
export async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args
): Promise<Result> {
  const [injection] = await scriptingApi().executeScript({
    target: { tabId },
    func: func as (...a: unknown[]) => unknown,
    args
  });
  return injection?.result as Result;
}

/** Invoke one page action via the single injected dispatcher. */
export function runPageAction<Result = unknown>(
  tabId: number,
  action: string,
  params: Record<string, unknown> = {}
): Promise<Result> {
  return runInPage(tabId, pageDispatch, [action, params]) as Promise<Result>;
}

/**
 * The one function injected into the page. Self-contained: all helpers are
 * defined inside it, and it dispatches on `action`. Returns a promise for the
 * async actions (executeScript awaits it).
 */
export async function pageDispatch(
  action: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const p = params as {
    ref?: string;
    selector?: string;
    x?: number;
    y?: number;
    name?: string;
    code?: string;
    text?: string;
    submit?: boolean;
    key?: string;
    value?: string;
    values?: string[];
    deltaX?: number;
    deltaY?: number;
    to?: "top" | "bottom";
    dblclick?: boolean;
    button?: "left" | "middle" | "right";
    state?: "visible" | "hidden" | "attached";
    timeoutMs?: number;
    maxNodes?: number;
    limit?: number;
    outer?: boolean;
    fields?: Array<{ ref?: string; selector?: string; value: string }>;
    from?: { ref?: string; selector?: string; x?: number; y?: number };
  };

  const resolveEl = (t: { ref?: string; selector?: string }): Element | null => {
    if (t.ref) {
      return document.querySelector(`[data-ocb-ref="${CSS.escape(t.ref)}"]`);
    }
    if (t.selector) {
      return document.querySelector(t.selector);
    }
    return null;
  };
  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  // Never surface password values in snapshots/queries/inspections — they flow
  // to the model and host logs. browser_snapshot is a default-group tool meant
  // to be called before interacting with forms, so this guards the common path.
  const SECRET_MASK = "••••••";
  const isSecret = (el: Element): boolean =>
    el instanceof HTMLInputElement && el.type === "password";
  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) {
      return aria.trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      return placeholder.trim();
    }
    const value = isSecret(el) ? "" : (el as HTMLInputElement).value;
    const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return (txt || value || "").slice(0, 80);
  };
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const mouseInit = (el: HTMLElement, x?: number, y?: number, button = "left"): MouseEventInit => {
    const rect = el.getBoundingClientRect();
    const index = button === "middle" ? 1 : button === "right" ? 2 : 0;
    const bit = button === "middle" ? 4 : button === "right" ? 2 : 1;
    return {
      bubbles: true,
      cancelable: true,
      button: index,
      buttons: bit,
      clientX: typeof x === "number" ? x : rect.left + rect.width / 2,
      clientY: typeof y === "number" ? y : rect.top + rect.height / 2,
      view: window
    };
  };

  switch (action) {
    case "snapshot": {
      const max = p.maxNodes ?? 200;
      const SELECTOR =
        'a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex]:not([tabindex="-1"])';
      for (const prev of Array.from(document.querySelectorAll("[data-ocb-ref]"))) {
        prev.removeAttribute("data-ocb-ref");
      }
      const lines: string[] = [];
      let n = 0;
      for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
        if (n >= max || !isVisible(el)) {
          continue;
        }
        n += 1;
        const ref = `e${n}`;
        el.setAttribute("data-ocb-ref", ref);
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type ? ` [${(el as HTMLInputElement).type}]` : "";
        const href = (el as HTMLAnchorElement).href ? ` → ${(el as HTMLAnchorElement).href}` : "";
        lines.push(`${ref}\t${role}${type}\t"${accessibleName(el)}"${href}`);
      }
      return { snapshot: lines.join("\n") || "(no interactive elements found)", refs: n };
    }

    case "getText":
      return { text: (document.body?.innerText ?? "").slice(0, 20000) };

    case "getHtml": {
      const el = resolveEl(p);
      const target = el ?? document.documentElement;
      if (p.ref || p.selector) {
        if (!el) {
          return { found: false, html: "" };
        }
      }
      const html = p.outer === false ? target.innerHTML : target.outerHTML;
      return { found: true, html: html.slice(0, 200_000) };
    }

    case "getAttribute": {
      const el = resolveEl(p);
      if (!el) {
        return { found: false };
      }
      const rect = el.getBoundingClientRect();
      const input = el as HTMLInputElement;
      const secret = isSecret(el);
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) {
        attrs[a.name] = secret && a.name === "value" ? SECRET_MASK : a.value;
      }
      return {
        found: true,
        tag: el.tagName.toLowerCase(),
        text: accessibleName(el),
        value: secret
          ? input.value
            ? SECRET_MASK
            : undefined
          : typeof input.value === "string"
            ? input.value
            : undefined,
        checked: typeof input.checked === "boolean" ? input.checked : undefined,
        attribute: p.name
          ? secret && p.name.toLowerCase() === "value"
            ? SECRET_MASK
            : el.getAttribute(p.name)
          : undefined,
        attributes: attrs,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    }

    case "query": {
      const selector = p.selector ?? "*";
      const limit = p.limit ?? 50;
      // Clear refs from a previous query first: reusing q1, q2, … without
      // clearing means a later action targeting "q1" could resolve to a stale
      // element left over from an earlier query and act on the wrong target.
      for (const prev of Array.from(document.querySelectorAll("[data-ocb-ref^='q']"))) {
        prev.removeAttribute("data-ocb-ref");
      }
      const nodes = Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .slice(0, limit);
      const elements = nodes.map((el, i) => {
        const ref = `q${i + 1}`;
        el.setAttribute("data-ocb-ref", ref);
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          text: accessibleName(el),
          href: (el as HTMLAnchorElement).href || undefined
        };
      });
      return { count: elements.length, elements };
    }

    case "getCenter": {
      const el = resolveEl(p);
      if (!el) {
        return { found: false, x: 0, y: 0 };
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      // A ref/selector can still resolve to a hidden element (display:none,
      // zero-size, visibility:hidden). Returning a center for it would make the
      // CDP click/hover/type paths fire trusted events at an invisible point
      // and report success — reject it instead.
      if (!isVisible(el)) {
        return { found: false, x: 0, y: 0 };
      }
      const rect = el.getBoundingClientRect();
      return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    case "activeEditable": {
      const el = document.activeElement;
      return {
        editable:
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          (el instanceof HTMLElement && el.isContentEditable)
      };
    }

    case "scroll": {
      if ((p.ref || p.selector) && !resolveEl(p)) {
        return { ok: false };
      }
      const scroller = p.ref || p.selector ? (resolveEl(p) ?? window) : window;
      if (p.to === "top") {
        (scroller as Element).scrollTo
          ? (scroller as Element).scrollTo(0, 0)
          : window.scrollTo(0, 0);
        return { ok: true };
      }
      if (p.to === "bottom") {
        const max =
          scroller === window ? document.body.scrollHeight : (scroller as Element).scrollHeight;
        (scroller as Element).scrollTo
          ? (scroller as Element).scrollTo(0, max)
          : window.scrollTo(0, max);
        return { ok: true };
      }
      const dx = p.deltaX ?? 0;
      const dy = p.deltaY ?? 0;
      if (scroller === window) {
        window.scrollBy(dx, dy);
      } else {
        (scroller as Element).scrollBy(dx, dy);
      }
      return { ok: true };
    }

    case "fill": {
      let filled = 0;
      for (const field of p.fields ?? []) {
        const el = resolveEl(field);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.focus();
          setNativeValue(el, field.value);
          filled += 1;
        }
      }
      return { filled };
    }

    case "select": {
      const el = resolveEl(p);
      if (!(el instanceof HTMLSelectElement)) {
        return { ok: false };
      }
      const wanted = new Set(p.values ?? (p.value !== undefined ? [p.value] : []));
      let matched = 0;
      for (const opt of Array.from(el.options)) {
        const sel = wanted.has(opt.value) || wanted.has(opt.label);
        opt.selected = sel;
        if (sel) {
          matched += 1;
        }
      }
      if (matched === 0) {
        return { ok: false };
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    case "waitForSelector": {
      const selector = p.selector ?? "";
      const state = p.state ?? "visible";
      const deadline = Date.now() + (p.timeoutMs ?? 10_000);
      const matches = (): boolean => {
        const el = selector ? document.querySelector(selector) : null;
        if (state === "attached") {
          return el !== null;
        }
        if (!el) {
          return state === "hidden";
        }
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        return state === "visible" ? visible : !visible;
      };
      while (Date.now() < deadline) {
        if (matches()) {
          return { found: true };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { found: matches() };
    }

    case "eval": {
      // Runs in the content-script (isolated) world — full DOM access, but not
      // the page's own JS globals. Result is JSON-roundtripped for transport.
      // biome-ignore lint/security/noGlobalEval: deliberate, behind the opt-in debug group.
      const raw = globalThis.eval(p.code ?? "");
      let result: unknown;
      try {
        result = JSON.parse(JSON.stringify(raw ?? null));
      } catch {
        result = String(raw);
      }
      return { result };
    }

    case "pointer": {
      const el =
        resolveEl(p) ??
        (typeof p.x === "number" && typeof p.y === "number"
          ? document.elementFromPoint(p.x, p.y)
          : null);
      if (!(el instanceof HTMLElement)) {
        return { ok: false };
      }
      const useCoords = typeof p.x === "number" && typeof p.y === "number" && !p.ref && !p.selector;
      if (!useCoords) {
        el.scrollIntoView({ block: "center" });
      }
      const init = mouseInit(
        el,
        useCoords ? p.x : undefined,
        useCoords ? p.y : undefined,
        p.button
      );
      el.focus();
      el.dispatchEvent(new PointerEvent("pointerdown", init));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.dispatchEvent(new PointerEvent("pointerup", init));
      el.dispatchEvent(new MouseEvent("mouseup", init));
      if (p.button === "right") {
        el.dispatchEvent(new MouseEvent("contextmenu", init));
      } else {
        el.dispatchEvent(new MouseEvent("click", init));
        if (p.dblclick) {
          el.dispatchEvent(new MouseEvent("dblclick", init));
        }
      }
      return { ok: true };
    }

    case "hover": {
      const el =
        resolveEl(p) ??
        (typeof p.x === "number" && typeof p.y === "number"
          ? document.elementFromPoint(p.x, p.y)
          : null);
      if (!(el instanceof HTMLElement)) {
        return { ok: false };
      }
      el.scrollIntoView({ block: "center" });
      const init = mouseInit(el);
      el.dispatchEvent(new PointerEvent("pointermove", init));
      el.dispatchEvent(new MouseEvent("mouseover", init));
      el.dispatchEvent(new MouseEvent("mousemove", init));
      el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
      return { ok: true };
    }

    case "drag": {
      const fromEl = resolveEl(p.from ?? {});
      const toEl = resolveEl(p);
      if (!(fromEl instanceof HTMLElement) || !(toEl instanceof HTMLElement)) {
        return { ok: false };
      }
      const dt = new DataTransfer();
      const fromInit = mouseInit(fromEl);
      const toInit = mouseInit(toEl);
      fromEl.dispatchEvent(new DragEvent("dragstart", { ...fromInit, dataTransfer: dt }));
      toEl.dispatchEvent(new DragEvent("dragover", { ...toInit, dataTransfer: dt }));
      toEl.dispatchEvent(new DragEvent("drop", { ...toInit, dataTransfer: dt }));
      fromEl.dispatchEvent(new DragEvent("dragend", { ...toInit, dataTransfer: dt }));
      return { ok: true };
    }

    case "type": {
      const el =
        (resolveEl(p) as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
      if (!el) {
        return { ok: false };
      }
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, (el.value ?? "") + (p.text ?? ""));
      } else if (el.isContentEditable) {
        el.textContent = (el.textContent ?? "") + (p.text ?? "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        return { ok: false };
      }
      if (p.submit) {
        const enter: KeyboardEventInit = {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          code: "Enter"
        };
        el.dispatchEvent(new KeyboardEvent("keydown", enter));
        el.dispatchEvent(new KeyboardEvent("keyup", enter));
        (el.closest("form") as HTMLFormElement | null)?.requestSubmit?.();
      }
      return { ok: true };
    }

    case "key": {
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      const raw = p.key ?? "";
      let ctrlKey = false;
      let altKey = false;
      let shiftKey = false;
      let metaKey = false;
      let key = raw;
      if (raw.length > 1) {
        const parts = raw.split("+");
        key = parts.pop() ?? "";
        for (const part of parts) {
          const lower = part.toLowerCase();
          if (lower === "ctrl" || lower === "control") ctrlKey = true;
          else if (lower === "alt" || lower === "option") altKey = true;
          else if (lower === "shift") shiftKey = true;
          else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super")
            metaKey = true;
        }
      }
      const init: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        key,
        code: key,
        ctrlKey,
        altKey,
        shiftKey,
        metaKey
      };
      const notCancelled = target.dispatchEvent(new KeyboardEvent("keydown", init));
      if (
        notCancelled &&
        !ctrlKey &&
        !altKey &&
        !metaKey &&
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      ) {
        const field = target;
        try {
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          if (key === "Backspace") {
            field.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (key === "Delete") {
            field.setRangeText(
              "",
              start,
              start === end ? Math.min(field.value.length, end + 1) : end,
              "end"
            );
            field.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (key === "Enter") {
            if (field instanceof HTMLTextAreaElement) {
              field.setRangeText("\n", start, end, "end");
              field.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              (field.closest("form") as HTMLFormElement | null)?.requestSubmit?.();
            }
          }
        } catch {
          /* selection unsupported on this input type */
        }
      }
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return { ok: true };
    }

    default:
      throw new Error(`unknown page action: ${action}`);
  }
}
