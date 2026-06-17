import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// Fourth build target (alongside the extension's app / content / webmcp passes):
// the Word task-pane add-in. It imports the portable core from ../src directly.
// Dev needs HTTPS (Office requirement) — generate localhost certs with
// `npx office-addin-dev-certs install` and pass them via the addin:dev script.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: resolve(here, 'taskpane.html') },
  },
  server: { port: 3000, strictPort: true },
});
