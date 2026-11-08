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
      // brittle exact-match churn. The process-exit drain lives in core-otel
      // (`exit-handlers.ts`, ADR-0018) and is covered there against an injected
      // process.
      thresholds: { statements: 90, branches: 85, functions: 82, lines: 90 }
    }
  }
});
