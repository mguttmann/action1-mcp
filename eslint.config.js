import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "warn",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Test doubles implement async interfaces (fetch, token providers)
    // without awaiting anything; that is intended there.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      // `typeof import("...")` types the modules a test re-imports after
      // vi.resetModules().
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
  {
    // Build and release scripts are plain ESM JavaScript without type
    // information: the rules that need types are off, the rest of the
    // recommended set applies, and undefined names are errors.
    files: ["scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-undef": "error",
    },
  },
);
