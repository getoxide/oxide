import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests compare the app against the brand kit, which lives outside web/.
  server: { fs: { allow: [".", "../assets/brand/oxide/palette"] } },
  test: {
    // Limit worker count so machines with many cores don't spawn more
    // isolated jsdom environments than the machine can comfortably run,
    // which caused flaky canvas/jsdom failures in AppGithubDock.
    maxWorkers: 4,
  },
});
