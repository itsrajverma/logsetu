import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as const,
  dts: true,
  sourcemap: true,
  treeshake: true,
  target: "es2020",
  external: ["react", "next"],
};

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts", next: "src/next.ts" }, clean: true },
  // rollup (treeshake) strips module directives, so keep esbuild-only and add the directive back as a banner
  { ...shared, treeshake: false, entry: { react: "src/react.tsx" }, banner: { js: '"use client";' } },
]);
