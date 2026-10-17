// Correctness checks deliberately avoid style rules: Prettier owns formatting.
// Features/*/dist contains authored CommonJS modules, despite its directory name.
module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "runtime/**",
      "features/installed/**",
      "experiments/**",
      "integrations/*/dist/**",
      "integrations/*/vendor/**",
    ],
  },
  {
    files: [
      "src/**/*.js",
      "features/**/*.js",
      "public/core/**/*.js",
      "integrations/**/*.cjs",
      "integrations/**/*.js",
      "scripts/**/*.js",
      "packages/**/*.js",
    ],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    rules: {
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-unreachable": "error",
      "no-constant-binary-expression": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-unsafe-finally": "error",
      "no-async-promise-executor": "error",
      "no-loss-of-precision": "error",
    },
  },
  {
    files: ["public/core/**/*.js"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: ["features/*/ui/*.js"],
    languageOptions: { sourceType: "script" },
  },
];
