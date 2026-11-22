import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The build is a single ES module, dist/apiquity.js, that defines the <apiquity-ui> element.
// Preact and the styles (injected into the element's shadow root) are bundled in.
export default defineConfig({
  plugins: [preact()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    // Library mode keeps whitespace in ES output by default; this is a script for the browser, so minify fully.
    rolldownOptions: { output: { minify: true } },
    lib: { entry: "src/apiquity-ui.tsx", formats: ["es"], fileName: () => "apiquity.js" },
  },
});
