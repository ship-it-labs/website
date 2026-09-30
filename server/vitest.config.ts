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
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
