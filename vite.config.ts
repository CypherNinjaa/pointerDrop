import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dual-target build:
 *   vite build --mode web        -> dist/            (GitHub Pages / Vercel static site)
 *   vite build --mode extension  -> dist-extension/  (Chrome / Edge MV3 side panel)
 *
 * The extension target additionally emits manifest.json and the MV3 background
 * service worker. Both targets share 100% of the application source.
 */
function extensionAssets(): Plugin {
  return {
    name: 'warp-extension-assets',
    apply: 'build',
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
      const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      manifest.version = pkg.version;
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source: readFileSync(resolve(__dirname, 'extension/service-worker.js'), 'utf8'),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isExtension = mode === 'extension';
  return {
    // Relative base works for GitHub Pages sub-paths, Vercel roots and chrome-extension:// origins alike.
    base: './',
    plugins: [react(), isExtension ? extensionAssets() : null],
    define: {
      __BUILD_TARGET__: JSON.stringify(isExtension ? 'extension' : 'web'),
    },
    worker: {
      format: 'es',
    },
    build: {
      outDir: isExtension ? 'dist-extension' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: !isExtension,
      // MV3 forbids inline scripts; the module preload polyfill is unnecessary in Chromium anyway.
      modulePreload: { polyfill: !isExtension },
      assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
      chunkSizeWarningLimit: 900,
    },
    server: {
      port: 5173,
      host: true,
    },
  };
});
