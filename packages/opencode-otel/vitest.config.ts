import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // Floors a few points below current so a regression fails CI without
      // brittle exact-match churn. `opencode.ts` (the only source file left in
      // this package now that the engine lives in `@vymalo/opencode-core-otel`)
      // is the thin spot — it is the host-wiring seam, and the part still
      // uncovered is the console-mirroring branch of the fallback logger. The
      // process-exit drain lives in core-otel (`exit-handlers.ts`, ADR-0018) and
      // is covered there against an injected process.
      thresholds: { statements: 82, branches: 75, functions: 76, lines: 82 }
    }
  }
});
