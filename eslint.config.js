import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.venv/**", "sessions/**", "**/*.tsbuildinfo"],
  },
  js.configs.recommended,
  {
    // Everything here runs on Node: sources, configs, and tools.
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Attribution failures in this project are silent. An ignored promise or
      // a quietly swallowed error is how they get that way.
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // The CLI is the one place that legitimately writes to stdout.
    files: ["packages/cli/**/*.ts", "packages/cli/bin/*.mjs", "tools/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.mjs", "*.config.js", "*.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
