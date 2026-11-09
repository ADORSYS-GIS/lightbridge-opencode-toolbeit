import { defineConfig } from "vitest/config";

// Separate config so the default `pnpm test` stays fast and hermetic. The
// integration suite hits a live `/v1/responses` gateway and skips itself when
// INTEGRATION_RESPONSES_URL is unset (see test/integration/).
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["../../scripts/vitest-isolated-home.mjs"],
    include: ["test/integration/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
