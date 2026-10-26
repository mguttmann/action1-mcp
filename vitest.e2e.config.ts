import { defineConfig } from "vitest/config";

// E2E checks of the built artifacts (`npm run test:e2e`): runs
// scripts/build-mcpb.sh once, then starts dist/index.js and the unpacked
// MCPB bundle over stdio with dummy credentials. Slow and needs the npm
// registry (npm ci inside the bundle), so it is not part of `npm test`.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
