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
 * Scans `src/` and fails on:
 *   1. an `await chrome…` call (whitespace-tolerant, newlines included);
 *   2. a `chrome.…(…)` call immediately chained into `.then(` / `.catch(` /
 *      `.finally(`.
 *
 * Comments are stripped first so the rule can be explained inline in the code.
 * This is a guard, not a parser: chained calls whose *arguments* contain
 * parentheses are not matched — extend the pattern should that shape appear.
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

/** Drop block and line comments so documenting the rule doesn't trip it. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "awaited chrome.* call", pattern: /\bawait\s+chrome\s*\./ },
  {
    name: "chrome.* call chained into .then()/.catch()/.finally()",
    pattern: /\bchrome\s*\.\s*\w+\s*\.\s*\w+\s*\(\s*[^()]*\)\s*\.\s*(?:then|catch|finally)\s*\(/
  }
];

describe("promise-namespace guard (issue #63)", () => {
  it("has no awaited or promise-chained chrome.* call under src/", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(code)) {
          violations.push(`${path.relative(SRC_DIR, file)} — ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
