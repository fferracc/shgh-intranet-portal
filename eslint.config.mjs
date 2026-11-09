import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

// Real rules, enabled 2026-09-23. Previously this file contained only an
// `ignores` block, so `next lint` passed trivially and caught nothing.
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "functions/**",
      "scripts/**",
      "Others/**",
      "src/_unpublished/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Warnings, not errors: the existing backlog should surface without
      // blocking a deploy. Tighten to "error" once the backlog is cleared.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "warn",

      // The existing backlog, downgraded so a deploy is never blocked by it.
      // Counts at the time of writing (2026-09-23):
      //   react/no-unescaped-entities   35  (apostrophes in JSX text, cosmetic)
      //   @typescript-eslint/no-require-imports  5
      //   prefer-const                   2  (auto-fixable)
      // Promote each back to "error" as its count reaches zero.
      "react/no-unescaped-entities": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "prefer-const": "warn",
    },
  },
];

export default eslintConfig;
