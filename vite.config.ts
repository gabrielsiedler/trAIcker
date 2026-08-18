import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The SPA builds into `dist/web`, which `src/server/app.ts` serves statically.
 * In dev, Vite serves the frontend and proxies /api to the Express process, so
 * there is one API implementation rather than two.
 */
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  plugins: [react()],
  server: {
    port: 4318,
    proxy: {
      // The API always lives in the other process — `traicker serve` in a
      // terminal, or the Electron shell's embedded server. TRAICKER_API_PORT is
      // set by scripts/dev-desktop.mjs from the real config, so a non-default
      // `serverPort` does not silently proxy into nothing.
      '/api': `http://localhost:${process.env['TRAICKER_API_PORT'] ?? 4317}`,
    },
  },
});
