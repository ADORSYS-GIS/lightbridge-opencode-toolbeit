import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["publish-guard.mjs"],
      reporter: ["text-summary"],
      thresholds: { statements: 88, branches: 85, functions: 65, lines: 88 }
    }
  }
});
