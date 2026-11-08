import { defineConfig } from 'vite';

// The window's colours and fonts come from the web UI's tokens (../web/src/ui/tokens.css): the dev server may read
// the repository root, not only tray/.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
