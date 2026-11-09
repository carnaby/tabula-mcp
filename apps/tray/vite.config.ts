import { defineConfig } from 'vite';

// The window's colours and fonts come from the web UI's tokens (../../web/src/ui/tokens.css): the dev server may
// read the sibling apps/ folder, not only apps/tray/.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
