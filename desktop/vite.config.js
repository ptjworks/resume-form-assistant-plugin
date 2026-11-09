import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    // pdf.js 的 cMap 是运行时按需 fetch 的静态资源，与插件同版本（见 vendor/pdfjs）。
    // vite-plugin-static-copy 默认保留源目录结构，这里用 stripBase 拍平到 dest 下。
    viteStaticCopy({
      targets: [
        { src: "node_modules/pdfjs-dist/cmaps/*", dest: "pdfjs/cmaps", rename: { stripBase: true } },
        { src: "node_modules/tesseract.js/dist/worker.min.js", dest: "ocr", rename: { stripBase: true } },
        { src: "node_modules/tesseract.js-core/tesseract-core*-lstm.wasm.js", dest: "ocr/core", rename: { stripBase: true } },
        { src: "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", dest: "ocr/lang", rename: { stripBase: true } },
        { src: "node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz", dest: "ocr/lang", rename: { stripBase: true } },
        { src: "node_modules/tesseract.js-core/LICENSE", dest: "ocr", rename: { stripBase: true } },
        { src: "node_modules/tesseract.js/LICENSE.md", dest: "ocr", rename: { stripBase: true } },
        // Preserve the license notices for the editor and its bundled dependencies.
        { src: "node_modules/@tiptap/*/LICENSE*", dest: "licenses" },
        { src: "node_modules/{prosemirror-*,orderedmap,rope-sequence,w3c-keyname,linkifyjs}/LICENSE*", dest: "licenses" },
      ],
    }),
  ],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
