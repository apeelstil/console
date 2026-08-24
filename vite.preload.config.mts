import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const preloadEntry = fileURLToPath(new URL('./electron/preload.ts', import.meta.url));
const preloadOutput = fileURLToPath(new URL('./dist-electron/electron', import.meta.url));

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: preloadEntry,
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    minify: false,
    outDir: preloadOutput,
    rollupOptions: {
      external: ['electron'],
    },
    sourcemap: false,
    target: 'node22',
  },
});
