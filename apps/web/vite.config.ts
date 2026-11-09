import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TABULA_API overrides the dev API proxy target; defaults to http://localhost:3000.
// Useful when the backend dev server runs on a different port (e.g. 3100 when
// 3000 is already taken locally).
const apiTarget = process.env.TABULA_API ?? 'http://localhost:3000';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': apiTarget } },
});
