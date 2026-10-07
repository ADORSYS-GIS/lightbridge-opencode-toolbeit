/// <reference types="chrome" />

// Namespace rule for this extension (issue #63):
//
// - Awaited / promise-chained extension API calls go through `browser` from
//   `wxt/browser` (which resolves to `globalThis.browser ?? globalThis.chrome`).
//   Chromium's `chrome.*` returns promises, but Firefox's `chrome.*` is
//   callback-only: awaiting it resolves to `undefined`, so e.g.
//   `await chrome.tabs.create(...)` yields `undefined` and the follow-up `.id`
//   access throws. `browser.*` is promise-based on both browsers.
// - `chrome.*` stays only where promises are not involved: event registration
//   (`runtime.onMessage`, `tabs.onRemoved`, …), synchronous calls and feature
//   detection (`runtime.getURL`, `typeof chrome.debugger`, …), the
//   callback-style debugger calls in `cdp.ts` (Chromium-only), and the
//   serialized functions injected into pages — those have no module scope and
//   Chromium content scripts have no `browser` global.
//
// `test/promise-namespace-guard.test.ts` enforces the awaited/chained half of
// this rule. Types for both namespaces come from @types/chrome.
