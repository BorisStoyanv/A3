import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/target/**", "**/.dfx/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.jsx"],
    languageOptions: { ecmaVersion: "latest", globals: globals.node },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["frontend/**/*.jsx", "frontend/**/*.js"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } }, globals: globals.browser },
  },
  { files: ["scripts/**/*.js", "**/*.cjs"], languageOptions: { sourceType: "commonjs" } },
];
