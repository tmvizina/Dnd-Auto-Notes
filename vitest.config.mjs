import { defineConfig } from "vitest/config";

// Workspace packages expose their TypeScript sources under the `@dnd/source`
// export condition. Without it the suite resolves `@dnd/core` to dist/ and
// silently tests the last build instead of the working tree.
const SOURCE_CONDITIONS = ["@dnd/source", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions: SOURCE_CONDITIONS },
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: {
    environment: "node",
    include: [
      "packages/**/src/**/*.test.ts",
      "app/**/src/**/*.test.{ts,tsx}",
      "test/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Stages are deterministic by contract; a suite that fails by timeout
    // would hide that. Generous but finite.
    testTimeout: 20_000,
  },
});
