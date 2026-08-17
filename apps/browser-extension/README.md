# OpenCode Browser — extension

Companion Chromium/Firefox extension for [`@vymalo/opencode-browser`](../../packages/opencode-browser)
and [`@vymalo/opencode-browser-mcp`](../../packages/opencode-browser-mcp). Its background worker
dials the localhost **bridge** and drives real browser tabs (open, click, type, scroll,
screenshot) on behalf of an agent, organized into **named tab groups**.

Built with **WXT** (cross-browser MV3), **React + Tailwind + shadcn-style UI**, **TanStack
Query**, and **Dexie/IndexedDB**.

> **Private package** — not published to npm. It ships as a Release zip and to the Chrome Web
> Store / Firefox Add-ons. See [publishing](#publishing).

## Install

Pick whichever is easiest:

| Source | How |
| --- | --- |
| **Chrome Web Store** | Search "OpenCode Browser" (once the listing is live), or use your org's link. |
| **Firefox Add-ons (AMO)** | Same — install the listed add-on. |
| **Release zip** | Grab `opencode-browser-extension-<ver>-chrome.zip` / `-firefox.zip` from [Releases](https://github.com/vymalo/opencode-oauth2/releases) and load unpacked. |
| **Build from source** | `pnpm build` (below), then load `.output/chrome-mv3` (or `.output/firefox-mv2`). |

### Load unpacked (zip / source)

- **Chrome / Edge / Brave**: `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
  pick `.output/chrome-mv3` (or unzip the chrome zip and pick that folder).
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  pick `.output/firefox-mv2/manifest.json`.

## Connect

1. Start an agent that hosts the bridge — the OpenCode plugin (`@vymalo/opencode-browser`) or the
   MCP server (`@vymalo/opencode-browser-mcp`). It prints a **token**.
2. Click the toolbar icon → **Dashboard** (or right-click → Options).
3. Enter the **bridge URL** (`ws://127.0.0.1:4517`), the **token**, optionally a **browser label**
   (handy when you run several browsers), choose an **executor**, then **Save & reconnect**.

> ⚠️ This gives an agent control of a real browser profile. **Use a dedicated or throwaway
> profile**, not your daily one. The "being debugged" banner Chrome shows during a session is an
> intentional signal that automation is active.

## Dashboard tour

- **Connection** — bridge URL, token, executor mode, browser label; live connection status.
- **Activity** — a timeline of every command the agent ran (action, group, params, result).
- **Screenshots** — a gallery of captures, stored locally in IndexedDB.
- **Popup** — a compact status + connect/disconnect toggle for quick checks.

## Executors

- **CDP** (`chrome.debugger`, Chromium) — trusted input, full-page capture, console & network
  logs. Shows the debugger banner.
- **Content script** — synthetic events + `captureVisibleTab`; the Firefox-safe fallback, also
  used when CDP is unavailable.
- **Auto** (default) — CDP on Chromium when the `debugger` permission is granted, else content.

The host plugin/MCP can advertise a preferred executor; the dashboard setting wins for your
session.

## Permissions

`tabs`, `scripting`, `cookies`, plus `debugger` + `tabGroups` + `sidePanel` on Chromium only
(dropped on Firefox, where the first two don't exist and the side panel maps to `sidebar_action`,
which needs no permission). `<all_urls>` host access is needed because the agent can target any
site you direct it to.

The list is kept exactly as wide as the code uses — the Chrome Web Store rejects permissions a
an extension declares but never calls. Notably **`storage` is not requested**: all persistence goes
through Dexie/IndexedDB, which needs no permission. `activeTab` isn't either — it would only
grant a subset of the `<all_urls>` access already required. Adding a permission back means
pointing at the call site that needs it.

The extension **collects no data off-device** — all
settings/history/screenshots live in local IndexedDB; the only network connection is the
loopback bridge you configure. The Firefox manifest declares `data_collection_permissions: none`
accordingly.

## Develop

```sh
pnpm dev            # WXT dev server + HMR (Chrome)
pnpm dev:firefox    # WXT dev server (Firefox)
pnpm build          # production build → .output/chrome-mv3
pnpm build:firefox  # → .output/firefox-mv2
pnpm zip            # packaged .zip for store / unpacked load
pnpm zip:firefox    # Firefox zip + a reviewable sources zip (for AMO)
pnpm typecheck      # wxt prepare && tsc --noEmit
pnpm test           # vitest (pure helpers)
```

## Layout

```
src/
├── entrypoints/
│   ├── background.ts        # service worker — wires the engine
│   ├── popup/               # compact status + connect toggle
│   └── options/             # full dashboard (connection / activity / screenshots)
├── background/              # BridgeClient, CommandRouter, GroupRegistry, executors, page-actions
├── shared/                  # protocol (mirror), types, Dexie db, messages
├── components/ + lib/       # shadcn-style UI kit, hooks, helpers
└── styles/globals.css       # Tailwind v4 theme tokens
```

The two executors share all DOM-bound work via `chrome.scripting.executeScript`. The CDP
executor (`chrome.debugger`) adds trusted input + full-page capture on Chromium; the
content-script executor is the Firefox-safe fallback. Full architecture, wire protocol, and tool
reference: [`docs/browser.md`](../../docs/browser.md).

## Publishing

`wxt zip` produces the store artifacts; the release pipeline attaches them to the GitHub Release
and runs `wxt submit` to the Chrome Web Store + Firefox AMO (each gated on its own repo secrets).
The Firefox add-on id is pinned to `opencode-browser@vymalo.com`. Full store-setup + secret list:
[`docs/browser.md` → Publishing the extension to the web stores](../../docs/browser.md#publishing-the-extension-to-the-web-stores).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Disconnected" in the dashboard | Check the bridge URL/port and that an agent is hosting it; re-copy the token. |
| Auth rejected | Token mismatch — paste exactly what the plugin/MCP logged. |
| Actions do nothing on Firefox | Some features are CDP/Chromium-only; Firefox uses the content executor. |
| Banner won't go away | Released on `browser_release` or when the agent exits — expected otherwise. |
