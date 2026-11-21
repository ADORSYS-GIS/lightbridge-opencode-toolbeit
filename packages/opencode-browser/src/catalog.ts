import type { BrowserAction } from "./protocol.js";
import type { Field, JsonInput, ToolGroup } from "./schema.js";

export type { ToolGroup } from "./schema.js";

export const TOOL_GROUPS: readonly ToolGroup[] = [
  "page",
  "control",
  "debug",
  "interactive"
] as const;
/** Groups registered when the operator doesn't specify — `debug` and `interactive` are opt-in. */
export const DEFAULT_GROUPS: readonly ToolGroup[] = ["page", "control"] as const;

/**
 * Structured result of an `interactive` feedback request — what the user marked
 * on the page. Spatial annotations resolve to a `data-ocb-ref` element ref where
 * possible (so the agent can act with `browser_click ref:…`), plus pixels as a
 * fallback. `comment` carries an optional free-text note attached to the mark.
 */
export type Annotation =
  | { kind: "confirm"; value: boolean }
  | { kind: "choice"; value: string }
  | { kind: "point"; x: number; y: number; ref?: string; selector?: string; text?: string }
  | { kind: "element"; ref?: string; selector?: string; text?: string }
  | {
      kind: "region";
      rect: { x: number; y: number; width: number; height: number };
      refs: string[];
      text?: string;
    };

export interface FeedbackResult {
  /** Whether a human responded before the timeout. */
  responded: boolean;
  /** True when the request timed out with no response. */
  timedOut?: boolean;
  /**
   * Set when the overlay couldn't be shown at all (e.g. a restricted or
   * CSP-locked page) — distinct from a plain timeout, so the agent can fall back
   * to screenshot/snapshot reasoning rather than re-asking.
   */
  error?: string;
  /** The marks the user made (empty when `timedOut`/`error`). */
  annotations: Annotation[];
}

/**
 * Adapter-neutral result of a tool call. The OpenCode adapter renders these to
 * its text-only `{ output, metadata }`; the MCP adapter renders text/json to a
 * TextContent and image to an inline ImageContent block.
 */
export type NeutralResult =
  | { kind: "text"; text: string }
  | { kind: "json"; data: unknown; text: string }
  | {
      kind: "image";
      base64: string;
      mimeType: string;
      width: number;
      height: number;
      partial?: boolean;
      text: string;
    };

export interface ToolSpec {
  name: string;
  group: ToolGroup;
  /** Wire action sent to the extension. */
  action: BrowserAction;
  description: string;
  input: JsonInput;
  /** Build the command params from validated args (default: the args verbatim). */
  params?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Shape the extension's reply into a neutral result (default: a short ack). */
  result?: (data: unknown, args: Record<string, unknown>) => NeutralResult;
  /**
   * Per-command timeout (ms) for this tool, overriding the bridge's global
   * default. Used by long-running, human-paced tools (e.g. feedback prompts).
   * Clamped broker-side to `maxCommandMs`. Omit for the normal fast-fail default.
   */
  timeoutMs?: number;
}

// ─── reusable fields ─────────────────────────────────────────────────────────
const group: Field = {
  type: "string",
  description: "Named tab group the action targets. Created on first browser_open."
};
const tabId: Field = {
  type: "number",
  optional: true,
  description: "Specific tab id; defaults to the group's active tab."
};
const refField: Field = {
  type: "string",
  optional: true,
  description: "Element ref from a prior browser_snapshot."
};
const selectorField: Field = { type: "string", optional: true, description: "CSS selector." };

// ─── helpers ─────────────────────────────────────────────────────────────────
function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function describeTarget(a: Record<string, unknown>): string {
  if (typeof a.ref === "string") {
    return `ref ${a.ref}`;
  }
  if (typeof a.selector === "string") {
    return `selector ${a.selector}`;
  }
  if (typeof a.x === "number" && typeof a.y === "number") {
    return `(${a.x}, ${a.y})`;
  }
  return "element";
}
const text = (t: string): NeutralResult => ({ kind: "text", text: t });
const json = (data: unknown, t: string): NeutralResult => ({ kind: "json", data, text: t });

/**
 * The single source of truth for the browser tool surface, shared by the
 * OpenCode plugin and the MCP server. Filter by `group` to gate what an agent
 * sees.
 */
export const BROWSER_TOOLS: readonly ToolSpec[] = [
  {
    name: "browser_open",
    group: "control",
    action: "open",
    description:
      "Open a new browser tab inside a named tab group (creates the group if it doesn't exist yet). Returns the tab id, final URL and page title.",
    input: {
      group,
      url: { type: "string", optional: true, description: "URL to load. Omit for a blank tab." },
      focus: {
        type: "boolean",
        optional: true,
        description: "Bring the tab to the foreground (default true)."
      },
      target: {
        type: "string",
        optional: true,
        description:
          "Which browser to open in (label or id from browser_targets). Omit unless several browsers are connected."
      }
    },
    result: (data, args) => {
      const d = rec(data);
      return {
        kind: "json",
        data: d,
        text: `Opened tab in group "${args.group}": ${d.title ?? "(untitled)"} — ${d.url ?? args.url ?? "about:blank"}`
      };
    }
  },
  {
    name: "browser_navigate",
    group: "control",
    action: "navigate",
    description: "Navigate an existing tab in the group to a new URL.",
    input: { group, url: { type: "string", description: "URL to navigate to." }, tabId },
    result: (data, args) => {
      const d = rec(data);
      return {
        kind: "json",
        data: d,
        text: `Navigated to ${d.url ?? args.url} (${d.title ?? ""})`.trim()
      };
    }
  },
  {
    name: "browser_click",
    group: "control",
    action: "click",
    description:
      "Click an element. Target it by `ref` (from browser_snapshot, most reliable), CSS `selector`, or absolute `x`/`y` coordinates.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      x: { type: "number", optional: true, description: "Absolute x coordinate (with y)." },
      y: { type: "number", optional: true, description: "Absolute y coordinate (with x)." },
      button: {
        type: "string",
        optional: true,
        enum: ["left", "middle", "right"],
        description: "Mouse button (default left)."
      },
      tabId
    },
    result: (_data, args) => text(`Clicked ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_double_click",
    group: "control",
    action: "double_click",
    description:
      "Double-click an element, targeted by `ref`, CSS `selector`, or `x`/`y` coordinates.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      x: { type: "number", optional: true },
      y: { type: "number", optional: true },
      tabId
    },
    result: (_data, args) =>
      text(`Double-clicked ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_type",
    group: "control",
    action: "type",
    description:
      "Type text into the focused element (or first focus `ref`/`selector`). Optionally press Enter after.",
    input: {
      group,
      text: { type: "string", description: "Text to type." },
      ref: refField,
      selector: selectorField,
      submit: { type: "boolean", optional: true, description: "Press Enter after typing." },
      tabId
    },
    result: (_data, args) =>
      text(
        `Typed ${String(args.text ?? "").length} character(s) into ${describeTarget(args)}${args.submit ? " and submitted" : ""}.`
      )
  },
  {
    name: "browser_fill",
    group: "control",
    action: "fill",
    description:
      "Fill several form fields in one call. Each field targets a `ref` or CSS `selector` and sets its `value`.",
    input: {
      group,
      fields: {
        type: "array",
        description: "Fields to fill, in order.",
        items: {
          type: "object",
          properties: { ref: refField, selector: selectorField, value: { type: "string" } }
        }
      },
      tabId
    },
    result: (data, args) => {
      const requested = Array.isArray(args.fields) ? args.fields.length : 0;
      const filled =
        typeof rec(data).filled === "number" ? (rec(data).filled as number) : requested;
      const missed = requested - filled;
      return text(
        `Filled ${filled} of ${requested} field(s) in group "${args.group}".${missed > 0 ? ` (${missed} not found)` : ""}`
      );
    }
  },
  {
    name: "browser_select",
    group: "control",
    action: "select",
    description: "Choose option(s) in a <select> element, or set the selection of a control.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      value: { type: "string", optional: true, description: "Single value to select." },
      values: {
        type: "array",
        optional: true,
        description: "Multiple values (multi-select).",
        items: { type: "string" }
      },
      tabId
    },
    result: (_data, args) => {
      const chosen = Array.isArray(args.values) ? args.values.join(", ") : (args.value ?? "");
      return text(`Selected ${chosen} in ${describeTarget(args)}.`);
    }
  },
  {
    name: "browser_scroll",
    group: "control",
    action: "scroll",
    description:
      "Scroll the page (or an element). Provide `deltaX`/`deltaY`, or `to: 'top' | 'bottom'`.",
    input: {
      group,
      deltaX: { type: "number", optional: true },
      deltaY: { type: "number", optional: true },
      ref: {
        type: "string",
        optional: true,
        description: "Scroll within this element instead of the page."
      },
      to: { type: "string", optional: true, enum: ["top", "bottom"] },
      tabId
    },
    result: (_data, args) => text(`Scrolled in group "${args.group}".`)
  },
  {
    name: "browser_press_key",
    group: "control",
    action: "press_key",
    description: 'Press a single key or chord (e.g. "Enter", "Escape", "Control+a").',
    input: { group, key: { type: "string", description: 'Key name, e.g. "Enter".' }, tabId },
    result: (_data, args) => text(`Pressed ${args.key} in group "${args.group}".`)
  },
  {
    name: "browser_wait",
    group: "control",
    action: "wait",
    description:
      "Wait for a fixed delay (`ms`) or until a `selector` reaches `state` (visible/hidden/attached).",
    input: {
      group,
      ms: { type: "number", optional: true, description: "Fixed delay in milliseconds." },
      selector: { type: "string", optional: true, description: "CSS selector to wait for." },
      state: { type: "string", optional: true, enum: ["visible", "hidden", "attached"] },
      tabId
    },
    result: (_data, args) =>
      text(
        args.selector
          ? `Waited for ${args.selector} (${args.state ?? "visible"}).`
          : `Waited ${args.ms ?? 0}ms.`
      )
  },
  {
    name: "browser_close",
    group: "control",
    action: "close",
    description: "Close a tab (pass `tabId`) or the whole group (omit `tabId`).",
    input: { group, tabId },
    result: (_data, args) =>
      text(
        args.tabId
          ? `Closed tab ${args.tabId} in group "${args.group}".`
          : `Closed group "${args.group}".`
      )
  },
  {
    name: "browser_release",
    group: "control",
    action: "release",
    description:
      "Release control of the browser: stop driving and detach the debugger (clears the 'being debugged' banner) without closing tabs. The next browser_* call re-attaches. Use this when you're done so the user gets their browser back.",
    input: {},
    result: () =>
      text("Released browser control. Tabs are left open; the next browser_* action re-attaches.")
  },
  {
    name: "browser_snapshot",
    group: "page",
    action: "snapshot",
    description:
      "Capture an accessibility/DOM snapshot of the page with stable element refs. Prefer this over guessing selectors — pass the returned refs to browser_click/type/etc.",
    input: { group, tabId },
    result: (data) => {
      const d = rec(data);
      return text(typeof d.snapshot === "string" ? d.snapshot : JSON.stringify(d, null, 2));
    }
  },
  {
    name: "browser_get_text",
    group: "page",
    action: "get_text",
    description: "Extract the visible text / readable content of the group's active tab.",
    input: { group, tabId },
    result: (data) => {
      const d = rec(data);
      return text(typeof d.text === "string" ? d.text : JSON.stringify(d));
    }
  },
  {
    name: "browser_tabs",
    group: "page",
    action: "tabs",
    description: "List open tab groups and their tabs. Omit `group` to list everything.",
    input: { group: { type: "string", optional: true, description: "Restrict to one group." } },
    params: (args) => ({ group: args.group }),
    result: (data) => ({ kind: "json", data, text: JSON.stringify(data, null, 2) })
  },
  {
    name: "browser_targets",
    group: "page",
    action: "targets",
    description:
      "List the browsers (extensions) currently connected to the bridge, with their id, label, browser and owned groups. Use a returned id/label as `target` in browser_open when several are connected.",
    input: {},
    result: (data) => ({ kind: "json", data, text: JSON.stringify(data, null, 2) })
  },
  {
    name: "browser_screenshot",
    group: "page",
    action: "screenshot",
    description:
      "Capture a screenshot of the group's active tab. Returns the image (the OpenCode plugin saves it to disk and returns the path — use the read tool to view it).",
    input: {
      group,
      fullPage: {
        type: "boolean",
        optional: true,
        description: "Capture the full scrollable page, not just the viewport."
      },
      tabId
    },
    result: (data) => {
      const d = rec(data);
      const width = Number(d.width ?? 0);
      const height = Number(d.height ?? 0);
      return {
        kind: "image",
        base64: String(d.base64 ?? ""),
        mimeType: "image/png",
        width,
        height,
        partial: Boolean(d.partial),
        text: `screenshot ${width}×${height}`
      };
    }
  },

  // ─── navigation (control) ──────────────────────────────────────────────────
  {
    name: "browser_back",
    group: "control",
    action: "back",
    description: "Go back in the tab's history.",
    input: { group, tabId },
    result: (data) => json(rec(data), `Went back to ${rec(data).url ?? ""}`.trim())
  },
  {
    name: "browser_forward",
    group: "control",
    action: "forward",
    description: "Go forward in the tab's history.",
    input: { group, tabId },
    result: (data) => json(rec(data), `Went forward to ${rec(data).url ?? ""}`.trim())
  },
  {
    name: "browser_reload",
    group: "control",
    action: "reload",
    description: "Reload the group's active tab.",
    input: { group, tabId },
    result: (data) => json(rec(data), `Reloaded ${rec(data).url ?? ""}`.trim())
  },
  {
    name: "browser_activate",
    group: "control",
    action: "activate",
    description: "Bring a group's tab to the foreground (focus its window and tab).",
    input: { group, tabId },
    result: (data) => json(rec(data), `Activated tab ${rec(data).tabId ?? ""}`.trim())
  },
  {
    name: "browser_hover",
    group: "control",
    action: "hover",
    description:
      "Move the pointer over an element (reveals hover menus/tooltips). Target by `ref`, `selector`, or `x`/`y`.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      x: { type: "number", optional: true },
      y: { type: "number", optional: true },
      tabId
    },
    result: (_d, args) => text(`Hovered ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_drag",
    group: "control",
    action: "drag",
    description: "Drag from a source element to a target element (each by `ref` or `selector`).",
    input: {
      group,
      fromRef: { type: "string", optional: true, description: "Source element ref." },
      fromSelector: { type: "string", optional: true, description: "Source CSS selector." },
      ref: { type: "string", optional: true, description: "Target element ref." },
      selector: { type: "string", optional: true, description: "Target CSS selector." },
      tabId
    },
    result: (_d, args) => text(`Dragged to ${describeTarget(args)} in group "${args.group}".`)
  },
  {
    name: "browser_upload",
    group: "control",
    action: "upload",
    description:
      "Set the files on a file <input>, by absolute path(s) on the machine running the bridge. CDP executor only (Chromium).",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      paths: {
        type: "array",
        description: "Absolute file path(s) to attach.",
        items: { type: "string" }
      },
      tabId
    },
    result: (_d, args) =>
      text(
        `Uploaded ${Array.isArray(args.paths) ? args.paths.length : 0} file(s) to ${describeTarget(args)}.`
      )
  },

  // ─── reading (page) ────────────────────────────────────────────────────────
  {
    name: "browser_get_html",
    group: "page",
    action: "get_html",
    description:
      "Get the HTML of the page (or of a `ref`/`selector` element). `outer: false` for innerHTML.",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      outer: { type: "boolean", optional: true, description: "Outer HTML (default true)." },
      tabId
    },
    result: (data) => text(String(rec(data).html ?? ""))
  },
  {
    name: "browser_get_attribute",
    group: "page",
    action: "get_attribute",
    description:
      "Read an element's tag, text, value, checked state, bounding box, and attributes (or one named attribute).",
    input: {
      group,
      ref: refField,
      selector: selectorField,
      name: { type: "string", optional: true, description: "A single attribute name to read." },
      tabId
    },
    result: (data) => json(rec(data), JSON.stringify(rec(data), null, 2))
  },
  {
    name: "browser_query",
    group: "page",
    action: "query",
    description:
      "Find visible elements matching a CSS selector. Returns each with a stable ref you can pass to other tools.",
    input: {
      group,
      selector: { type: "string", description: "CSS selector to match." },
      limit: { type: "number", optional: true, description: "Max matches (default 50)." },
      tabId
    },
    result: (data) => json(rec(data), JSON.stringify(rec(data), null, 2))
  },

  // ─── debug (off by default) ────────────────────────────────────────────────
  {
    name: "browser_eval",
    group: "debug",
    action: "eval",
    description:
      "Evaluate JavaScript in the page's DOM context and return the JSON-serializable result. Powerful — enabled only when the `debug` group is on.",
    input: { group, code: { type: "string", description: "JavaScript to evaluate." }, tabId },
    result: (data) => {
      const r = rec(data).result;
      return json(rec(data), typeof r === "string" ? r : JSON.stringify(r, null, 2));
    }
  },
  {
    name: "browser_console",
    group: "debug",
    action: "console",
    description:
      "Return recent console output (logs, warnings, errors). CDP on Chromium, a page hook on Firefox.",
    input: { group, tabId },
    result: (data) => {
      const entries = (rec(data).entries as unknown[]) ?? [];
      return json(rec(data), JSON.stringify(entries, null, 2));
    }
  },
  {
    name: "browser_network",
    group: "debug",
    action: "network",
    description:
      "Return recent network requests (method, URL, status). CDP on Chromium, webRequest on Firefox.",
    input: { group, tabId },
    result: (data) => {
      const entries = (rec(data).entries as unknown[]) ?? [];
      return json(rec(data), JSON.stringify(entries, null, 2));
    }
  },
  {
    name: "browser_handle_dialog",
    group: "debug",
    action: "handle_dialog",
    description:
      "Accept or dismiss a pending JavaScript dialog (alert/confirm/prompt). On Firefox dialogs are auto-answered instead (alert → ok, confirm → false, prompt → null) and recorded in its console output.",
    input: {
      group,
      accept: { type: "boolean", optional: true, description: "Accept (default true) or dismiss." },
      promptText: { type: "string", optional: true, description: "Text for a prompt() dialog." },
      tabId
    },
    result: (_d, args) => text(`${args.accept === false ? "Dismissed" : "Accepted"} the dialog.`)
  },
  {
    name: "browser_set_viewport",
    group: "debug",
    action: "set_viewport",
    description: "Emulate a viewport size / device metrics. CDP executor only (Chromium).",
    input: {
      group,
      width: { type: "number", description: "Viewport width in CSS px." },
      height: { type: "number", description: "Viewport height in CSS px." },
      mobile: { type: "boolean", optional: true, description: "Emulate a mobile device." },
      deviceScaleFactor: {
        type: "number",
        optional: true,
        description: "Device pixel ratio (0 = default)."
      },
      tabId
    },
    result: (_d, args) => text(`Set viewport to ${args.width}×${args.height}.`)
  },
  {
    name: "browser_cookies",
    group: "debug",
    action: "cookies",
    description:
      "Read or modify cookies. `op`: get (by url+name), list (by url), set (url+name+value), clear (url+name).",
    input: {
      group: {
        type: "string",
        optional: true,
        description: "Group (unused; cookies are profile-wide)."
      },
      op: { type: "string", enum: ["get", "list", "set", "clear"], description: "Operation." },
      url: { type: "string", optional: true, description: "URL the cookie applies to." },
      name: { type: "string", optional: true },
      value: { type: "string", optional: true },
      domain: { type: "string", optional: true },
      path: { type: "string", optional: true }
    },
    params: (args) => ({
      op: args.op,
      url: args.url,
      name: args.name,
      value: args.value,
      domain: args.domain,
      path: args.path
    }),
    result: (data) => json(rec(data), JSON.stringify(rec(data), null, 2))
  },
  {
    name: "browser_request_feedback",
    group: "interactive",
    action: "request_feedback",
    description:
      "Ask the human at the browser to respond on the page, and block until they do (or it times out). Use when you're unsure what the user means and a screenshot or snapshot isn't enough — e.g. 'which of these did you mean?'. `mode`: confirm (yes/no bar), choose (pick one of `options`), point (click one spot), element (hover-highlight then click one element), region (drag a box over an area), comment (point + a free-text note). point/element/region resolve to element ref(s) you can then click/snapshot. Returns the user's response; on timeout returns `{ timedOut: true }` so you can fall back. interactive group (opt-in).",
    timeoutMs: 300_000,
    input: {
      group,
      mode: {
        type: "string",
        enum: ["confirm", "choose", "point", "element", "region", "comment"],
        description: "Kind of prompt: confirm | choose | point | element | region | comment."
      },
      prompt: {
        type: "string",
        optional: true,
        description: "Question/instruction shown to the user above the controls."
      },
      options: {
        type: "array",
        optional: true,
        items: { type: "string" },
        description: "Choices for `choose` mode (ignored otherwise)."
      },
      timeoutMs: {
        type: "number",
        optional: true,
        description: "How long to wait for the user, in ms (default 120000, max 290000)."
      },
      tabId
    },
    params: (args) => {
      const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : 120_000;
      return {
        mode: args.mode,
        prompt: args.prompt,
        options: Array.isArray(args.options) ? args.options : undefined,
        // Keep the overlay's own countdown below the broker deadline (300s) so it
        // self-resolves into a clean `timedOut` result rather than being cancelled.
        timeoutMs: Math.min(Math.max(requested, 1_000), 290_000),
        tabId: args.tabId
      };
    },
    result: (data) => {
      const d = data as Partial<FeedbackResult>;
      if (d?.error) {
        return json(
          { responded: false, error: d.error, annotations: [] } satisfies FeedbackResult,
          `Couldn't ask the user on this page: ${d.error}. Fall back to a screenshot/snapshot.`
        );
      }
      if (!d || d.responded === false || d.timedOut) {
        return json(
          { responded: false, timedOut: true, annotations: [] } satisfies FeedbackResult,
          "No response from the user within the time limit."
        );
      }
      const annotations = Array.isArray(d.annotations) ? d.annotations : [];
      return json(
        { responded: true, annotations } satisfies FeedbackResult,
        summarizeAnnotations(annotations)
      );
    }
  }
];

/** A short human-readable line describing what the user marked. */
function summarizeAnnotations(annotations: Annotation[]): string {
  if (annotations.length === 0) {
    return "User responded with no marks.";
  }
  return annotations
    .map((a) => {
      const note = "text" in a && a.text ? ` — "${a.text}"` : "";
      if (a.kind === "confirm") {
        return `User ${a.value ? "confirmed" : "declined"}.`;
      }
      if (a.kind === "choice") {
        return `User chose "${a.value}".`;
      }
      if (a.kind === "element") {
        const what = a.ref ? `ref ${a.ref}` : (a.selector ?? "an element");
        return `User selected ${what}${note}.`;
      }
      if (a.kind === "region") {
        const refs = a.refs.length ? ` covering ${a.refs.join(", ")}` : "";
        return `User boxed a ${Math.round(a.rect.width)}×${Math.round(a.rect.height)} region${refs}${note}.`;
      }
      const where = a.ref ? `ref ${a.ref}` : `(${Math.round(a.x)}, ${Math.round(a.y)})`;
      return `User pointed at ${where}${note}.`;
    })
    .join(" ");
}
