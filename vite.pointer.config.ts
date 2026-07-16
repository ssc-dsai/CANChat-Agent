import { defineConfig } from 'vite';

// Pointer tracker build: a single IIFE injected as an always-on content script.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/pointerTracker.ts',
      name: 'CanagentPointerTracker',
      formats: ['iife'],
      fileName: () => 'pointerTracker.js',
    },
  },
});
