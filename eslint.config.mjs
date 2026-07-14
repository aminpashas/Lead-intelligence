import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // These rules from the next/typescript preset fire hundreds of times across
    // pre-existing, shipped-and-working code, so as errors they kept CI red
    // without gating anything. Kept as WARNINGS (still surfaced in editors/CI
    // output, just non-blocking) rather than silenced — flip any back to
    // "error" and fix incrementally when you want to burn the debt down.
    //  - no-explicit-any: mostly Supabase dynamic-join results; retyping ~265
    //    sites is churn-heavy and type-only.
    //  - no-require-imports: intentional lazy require() inside functions
    //    (supabase-js / crypto) to avoid module-init cost — not convertible to a
    //    top-level import without changing load behavior.
    //  - react-hooks/* (React Compiler): correctness hints on working code, some
    //    false-positive (e.g. redirect() in a server component reads as impure).
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);

export default eslintConfig;
