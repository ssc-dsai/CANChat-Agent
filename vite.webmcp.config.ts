import { defineConfig } from 'vite';

// WebMCP bridge build: a single IIFE injected as a MAIN-world content script at
// document_start (see manifest content_scripts). No runtime imports.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/webmcpBridge.ts',
      name: 'CanagentWebMcpBridge',
      formats: ['iife'],
      fileName: () => 'webmcpBridge.js',
    },
  },
});
