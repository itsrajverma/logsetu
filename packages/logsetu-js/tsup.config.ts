import { defineConfig } from "tsup";
import fs from "node:fs";

// Single build for all entries (parallel array configs raced on `clean` and could delete each
// other's output). rollup/treeshake strips the "use client" directive, so it is re-added afterwards.
export default defineConfig({
  entry: { index: "src/index.ts", next: "src/next.ts", react: "src/react.tsx" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  treeshake: true,
  clean: true,
  target: "es2020",
  external: ["react", "next"],
  onSuccess: async () => {
    for (const f of ["dist/react.js", "dist/react.cjs"]) {
      const src = fs.readFileSync(f, "utf8");
      if (!src.startsWith('"use client";')) fs.writeFileSync(f, `"use client";\n${src}`);
    }
  },
});
