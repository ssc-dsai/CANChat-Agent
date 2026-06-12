import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Builds the sidebar page and the background service worker.
// The content script is built separately (vite.content.config.ts) because it
// must be a single self-contained IIFE.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidebar: 'sidebar.html',
        offscreen: 'offscreen.html',
        serviceWorker: 'src/background/serviceWorker.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'serviceWorker' ? 'serviceWorker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
