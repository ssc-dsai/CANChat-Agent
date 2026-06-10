import { defineConfig } from 'vite';

// Content script build: single IIFE file with no runtime imports, injected
// dynamically via chrome.scripting.executeScript.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/contentScript.ts',
      name: 'BrowserAgentContent',
      formats: ['iife'],
      fileName: () => 'contentScript.js',
    },
  },
});
