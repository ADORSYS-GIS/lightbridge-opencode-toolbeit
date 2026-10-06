/// <reference types="chrome" />

// Background code uses the `chrome.*` namespace directly for event registration
// and feature-detected APIs (debugger, tabGroups). Promise-awaited tab /
// scripting / window / cookie calls go through `lib/browser-apis.ts`, which
// prefers the promise-based `browser.*` namespace on Firefox — Firefox's
// `chrome.*` is callback-style and awaiting it resolves to `undefined`
// (issue #63). Types come from @types/chrome.
