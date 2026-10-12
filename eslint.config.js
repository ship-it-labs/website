import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

/**
 * Flat ESLint config for the whole workspace: the Vite/React frontend under
 * `src/` and the Fastify control plane under `server/src/`. Both are TypeScript,
 * but they run in different worlds — the browser has `window`/`document`, the
 * server has `process`/`Buffer` — so globals are scoped per tree rather than
 * declaring everything everywhere (which hides real `no-undef` mistakes).
 *
 * Rules are tuned for this codebase: the type-checker already proves a lot, so
 * a handful of stylistic rules that fight the existing style (explicit `any` in
 * the DB-shim layer, empty `catch` blocks that intentionally swallow) are
 * relaxed. Anything left as an error is a genuine bug, not a preference.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.data/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/tsconfig.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      // The DB driver lives behind a union of two clients whose shapes genuinely
      // differ; a shared `any` bridge is smaller than two parallel type trees.
      "@typescript-eslint/no-explicit-any": "off",
      // Unused args are common in framework signatures (Fastify handlers keep
      // `reply` even when unused). Underscore-prefixed names are intentional.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `catch {}` with a comment is a deliberate, documented swallow in this
      // codebase (best-effort logging, optional attribution); don't flag it.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Template literals with a non-string are fine when the values are known
      // scalars; the rule is noisy on numeric ids.
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },

  // Frontend: browser globals + React rules.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Fast-refresh only works when a module exports components (and constant
      // values); mixing in other named exports forces a full reload in dev.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Server + tests + build scripts: Node globals.
  {
    files: ["server/src/**/*.ts", "server/tests/**/*.ts", "scripts/**/*.{js,mjs}", "*.config.{js,ts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Test files lean on non-null assertions after expectations narrow types.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // The PostCSS/Tailwind configs are CommonJS-ish and only need Node globals.
  {
    files: ["**/*.config.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
