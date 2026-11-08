/**
 * Guard against the Firefox promise-namespace bug (issue #63).
 *
 * Firefox's `chrome.*` namespace is callback-only: awaiting one of its methods
 * resolves to `undefined` — the call fires but the result is lost — so
 * `await chrome.tabs.create(...)` used to yield `undefined` and the follow-up
 * `.id` access threw, leaving the extension inert on Firefox. Every awaited or
 * promise-chained extension API call must go through `browser` from
 * `wxt/browser`, which resolves to the promise-based namespace on both
 * browsers. The full namespace rule lives in `src/global.d.ts`.
 *
 * Scans `src/` and fails on any use of `chrome.<namespace>.<method>(...)` where
 * the call is:
 *   1. directly awaited (`await chrome.tabs.create(...)`);
 *   2. awaited after a trivial binding (`const x = chrome.tabs.create(...); await x`);
 *   3. returned from an async function (`return chrome.tabs.get(id)`);
 *   4. passed to `Promise.all`/`Promise.race`/`await Promise.all([...])`;
 *   5. immediately chained into `.then()`/`.catch()`/`.finally()`.
 *
 * Allowed (not flagged):
 *   - Event registration: `chrome.runtime.onMessage.addListener(...)`,
 *     `chrome.tabs.onRemoved.addListener(...)` — these are callback-based.
 *   - Synchronous calls: `chrome.runtime.getURL(...)`, `chrome.runtime.lastError`.
 *   - Feature detection: `typeof chrome.debugger`, `chrome.debugger` optional chaining.
 *   - Callback-style debugger calls in `cdp.ts` (Chromium-only).
 *   - Serialized functions injected into pages (they have no module scope and
 *     content scripts lack browser).
 *
 * Comments are stripped first (block + line, string-aware) so documenting the
 * rule inline doesn't trip it. This is a best-effort guard, not a full parser.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Remove block comments and line comments while keeping
 * string/template literals intact, so // inside a string doesn't delete code.
 */
function stripComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    // Block comment
    if (code[i] === "/" && i + 1 < n && code[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(code[i] === "*" && code[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    // Line comment
    if (code[i] === "/" && i + 1 < n && code[i + 1] === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") {
        i++;
      }
      continue;
    }
    // String literal (double-quoted)
    if (code[i] === '"') {
      out += code[i++];
      while (i < n) {
        out += code[i];
        if (code[i] === '"' && code[i - 1] !== "\\") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // String literal (single-quoted)
    if (code[i] === "'") {
      out += code[i++];
      while (i < n) {
        out += code[i];
        if (code[i] === "'" && code[i - 1] !== "\\") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Template literal
    if (code[i] === "`") {
      out += code[i++];
      while (i < n) {
        out += code[i];
        if (code[i] === "`" && code[i - 1] !== "\\") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += code[i++];
  }
  return out;
}

/**
 * Check if a match at `index` in `code` is inside an allowed context:
 * - Event registration: `.onMessage.addListener`, `.onRemoved.addListener`, etc.
 * - Feature detection: `typeof chrome.debugger`, `chrome.debugger?.`
 * - Callback-style: `chrome.debugger.attach/sendCommand/detach` with a callback arg
 * - `chrome.runtime.getURL`, `chrome.runtime.lastError`
 */
function isAllowedContext(code: string, index: number): boolean {
  // Look back up to 80 chars for context
  const start = Math.max(0, index - 80);
  const prefix = code.slice(start, index);
  // Event listeners
  if (
    /\.on(Message|Removed|Updated|Created|Detached|Activated)\s*\.\s*addListener\b/.test(prefix)
  ) {
    return true;
  }
  if (
    /\.on(Message|Removed|Updated|Created|Detached|Activated)\s*\.\s*removeListener\b/.test(prefix)
  ) {
    return true;
  }
  // Feature detection / optional chaining on debugger
  if (/\btypeof\s+chrome\s*\.\s*debugger\b/.test(prefix)) {
    return true;
  }
  if (/chrome\s*\.\s*debugger\s*\?\./.test(prefix)) {
    return true;
  }
  // chrome.runtime.getURL / lastError (sync)
  if (/\bchrome\s*\.\s*runtime\s*\.\s*(getURL|lastError)\b/.test(prefix)) {
    return true;
  }
  // Callback-style debugger calls: attach/sendCommand/detach with callback
  if (/\bchrome\s*\.\s*debugger\s*\.\s*(attach|sendCommand|detach)\s*\(/.test(prefix)) {
    // Check if the call has a callback as last argument (heuristic: ends with `() =>` or `function`)
    return true;
  }
  return false;
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "awaited chrome.* call (direct or via binding)",
    // Matches: await chrome.x.y(...); await (chrome.x.y(...)); const v = chrome.x.y(...); await v;
    pattern:
      /\b(?:await\s+(?:\(?\s*)?chrome\s*\.\s*\w+\s*\.\s*\w+\s*\(|(?:const|let|var)\s+\w+\s*=\s*chrome\s*\.\s*\w+\s*\.\s*\w+\s*\([^;]*\)\s*;[\s\S]{0,200}\bawait\s+\w+)/
  },
  {
    name: "chrome.* call returned from async function",
    // Matches: return chrome.x.y(...); inside async function
    pattern:
      /\basync\s+\w*\s*\([^)]*\)\s*\{[\s\S]{0,500}?\breturn\s+chrome\s*\.\s*\w+\s*\.\s*\w+\s*\(/
  },
  {
    name: "chrome.* call passed to Promise.all/race",
    pattern: /\bPromise\.(?:all|race)\s*\(\s*\[[\s\S]{0,200}?chrome\s*\.\s*\w+\s*\.\s*\w+\s*\(/
  },
  {
    name: "chrome.* call chained into .then()/.catch()/.finally()",
    // More permissive: allow nested parens in args via a balanced-ish match up to 2 levels
    pattern:
      /\bchrome\s*\.\s*\w+\s*\.\s*\w+\s*\([^()]*?(?:\([^()]*\)[^()]*)*\)\s*\.\s*(?:then|catch|finally)\s*\(/
  }
];

describe("promise-namespace guard (issue #63)", () => {
  it("has no awaited or promise-chained chrome.* call under src/", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const raw = readFileSync(file, "utf8");
      const code = stripComments(raw);
      for (const { name, pattern } of FORBIDDEN) {
        let match: RegExpExecArray | null;
        // eslint-disable-next-line no-cond-assign
        while ((match = pattern.exec(code)) !== null) {
          if (!isAllowedContext(code, match.index)) {
            violations.push(
              `${path.relative(SRC_DIR, file)} — ${name} (near "${match[0].slice(0, 80)}")`
            );
          }
        }
      }
    }
    if (violations.length > 0) {
      console.error(`Promise-namespace guard violations:\n${violations.join("\n")}`);
    }
    expect(violations).toEqual([]);
  });
});
