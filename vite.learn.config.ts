import { defineConfig } from 'vite';

// Learn-mode recorder build: a single IIFE injected as an always-on content script.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/interactionRecorder.ts',
      name: 'CanagentInteractionRecorder',
      formats: ['iife'],
      fileName: () => 'interactionRecorder.js',
    },
  },
});
