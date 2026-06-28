import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// Copy the ONNX Runtime Web wasm binary into dist/ort/ so the on-device
// embedder (transformers.js) loads it from an extension-local URL instead of a
// CDN — keeps local RAG working offline and within the MV3 CSP. The ~20 MB
// binary stays in node_modules (not committed); it's emitted only at build time.
function copyOrtWasm(): Plugin {
  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    writeBundle() {
      const ortDist = join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
      const outDir = join('dist', 'ort');
      mkdirSync(outDir, { recursive: true });
      for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
        try {
          copyFileSync(join(ortDist, f), join(outDir, f));
        } catch {
          // Variant not present in this onnxruntime-web build — skip.
        }
      }
    },
  };
}

// Build-stamp version shown in the header: YY (year) + DDD (day-of-year,
// zero-padded) + HH (hour, 24h, zero-padded). All UTC, so builds from any
// timezone are comparable. Computed once per build, so it identifies the build
// rather than ticking while the panel is open.
function buildVersion(): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 0); // Dec 31 of prior year, 00:00 UTC
  const dayOfYear = Math.floor((now.getTime() - startOfYear) / 86_400_000); // 1..366
  const ddd = String(dayOfYear).padStart(3, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  return `${yy}${ddd}${hh}`;
}

// Builds the sidebar page and the background service worker.
// The content script is built separately (vite.content.config.ts) because it
// must be a single self-contained IIFE.
export default defineConfig({
  plugins: [preact(), copyOrtWasm()],
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidebar: 'sidebar.html',
        offscreen: 'offscreen.html',
        microphone: 'microphone.html',
        map: 'map.html',
        workspace: 'workspace.html',
        serviceWorker: 'src/background/serviceWorker.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'serviceWorker' ? 'serviceWorker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
