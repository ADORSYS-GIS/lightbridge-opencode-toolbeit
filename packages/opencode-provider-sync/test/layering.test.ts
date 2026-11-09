import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * House rule (ADR-0021): the engines never import the plugin API. They report a
 * needed sign-in through the plain-TS `SignInReporter`; only a plugin adapter
 * touches `ctx.integration`. `opencode-helpers.ts` is the one provider-sync
 * file that IS the plugin-side adapter layer (it types the provider editor),
 * so it is the single named exception.
 */
const ENGINE_FILES = [
  ...sources(join(packages, "opencode-auth-core", "src")),
  ...sources(join(packages, "opencode-provider-sync", "src")).filter(
    (file) => !file.endsWith("opencode-helpers.ts")
  )
];

describe("layering: engines have no plugin-API import", () => {
  it("scans a meaningful set of files", () => {
    expect(ENGINE_FILES.length).toBeGreaterThan(20);
    expect(ENGINE_FILES.some((file) => file.endsWith("engine.ts"))).toBe(true);
    expect(ENGINE_FILES.some((file) => file.endsWith("sign-in-notice.ts"))).toBe(true);
  });

  it.each(ENGINE_FILES.map((file) => [relative(packages, file), file]))(
    "%s imports nothing from @opencode/*",
    (_label, file) => {
      const text = readFileSync(String(file), "utf8");
      const importsHost = /(?:from|import)\s*\(?\s*["']@opencode\//.test(text);
      expect(importsHost).toBe(false);
    }
  );
});
