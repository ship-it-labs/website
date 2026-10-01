import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite strips the `node:` prefix and then tries to resolve `sqlite` from
    // npm. Mapping it back keeps the builtin intact under test.
    alias: [{ find: /^node:sqlite$/, replacement: "node:sqlite" }],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Several suites import the real @whop/sdk graph, which needs several
    // seconds to load when the workers run in parallel. The assertions
    // themselves are instant, so the default 5s budget produced failures that
    // only appeared under full-suite load.
    testTimeout: 30000,
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
