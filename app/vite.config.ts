import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // the packaged app loads index.html from disk
  server: { port: 5273, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
