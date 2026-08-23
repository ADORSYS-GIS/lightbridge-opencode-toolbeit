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
      // brittle exact-match churn. The plugin-host wiring (process-exit drain,
      // the OpenCode-logger adapter) lives in `@vymalo/opencode-otel`, not
      // here — this package is the engine only.
      thresholds: { statements: 92, branches: 82, functions: 89, lines: 92 }
    }
  }
});
