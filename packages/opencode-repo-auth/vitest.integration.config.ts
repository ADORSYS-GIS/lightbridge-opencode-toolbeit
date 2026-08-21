import { defineConfig } from "vitest/config";

// Separate config so the default `pnpm test` (unit tests) stays fast and
// hermetic. Integration tests require the test-env compose stack to be up;
// they skip themselves when INTEGRATION_REPO_AUTH_TOKEN_URL is unset.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
