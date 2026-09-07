// Type-aware linting for both MCP packages.
//
// strictTypeChecked rather than `recommended`: the rules that earn their keep
// here are the ones that need the type checker — no-floating-promises,
// no-misused-promises, no-unnecessary-condition. Those find real defects in
// async server code, which is all this repo is. The purely stylistic rules are
// on too, but only because they are free once the type information is loaded.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.test-build/**",
      "**/node_modules/**",
      "**/generated/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService discovers each package's tsconfig.json on its own,
        // which is what makes one root config cover two independent packages.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // These servers log to stderr on purpose: stdout belongs to the MCP
      // stdio transport, and polluting it corrupts the protocol.
      "no-console": "off",

      // A leading underscore marks a parameter kept only to satisfy an
      // interface. NoUpstreamAuth.authorize is the case that matters: trimming
      // its signature to `()` is legal TypeScript but makes the class
      // uncallable through its own type.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["**/test/**/*.ts"],
    rules: {
      // node:test's describe/it return promises that its own runner awaits.
      // Flagging them is correct in general and noise here; `void describe(...)`
      // on every block would be worse than turning the rule off for tests.
      "@typescript-eslint/no-floating-promises": "off",

      // Fixtures and assertions index into known-shaped literals. A non-null
      // assertion in a test fails loudly on the next line if it is wrong, which
      // is the whole point of a test.
      "@typescript-eslint/no-non-null-assertion": "off",

      // Test doubles and JSON-RPC envelopes are genuinely dynamic.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
