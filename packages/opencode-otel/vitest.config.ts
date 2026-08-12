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
      // brittle exact-match churn. `opencode.ts` is the thin spot — it is the
      // host-wiring seam, and the parts still uncovered are the process-exit
      // drain and the console-mirroring branch of the fallback logger.
      thresholds: { statements: 92, branches: 85, functions: 86, lines: 92 }
    }
  }
});
