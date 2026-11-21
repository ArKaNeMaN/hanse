import { defineConfig } from "vite";

/** The Mermaid renderer is a separate, self-contained IIFE inlined into the frame HTML. */
export default defineConfig({
  build: {
    lib: {
      entry: "ui/mermaid-frame.ts",
      formats: ["iife"],
      name: "HanseMermaidFrame",
      fileName: () => "mermaid-frame.iife.js",
    },
    outDir: "assets/ui/.frame-build",
    emptyOutDir: true,
    minify: "esbuild",
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
