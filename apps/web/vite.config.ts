import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // pdf.js loads CMaps and standard fonts at runtime; serve them from the
    // app root in both dev and production builds.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps', rename: { stripBase: true } },
        {
          src: 'node_modules/pdfjs-dist/standard_fonts/*',
          dest: 'standard_fonts',
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  server: {
    port: 5173,
    // `VITE_DEV_API_ORIGIN` lets a dev build point at the local Compose stack
    // (http://localhost:8180) while the default keeps the usual server port.
    proxy: {
      '/api': process.env.VITE_DEV_API_ORIGIN ?? 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // Playwright specs live next to Vitest suites but use another runner.
    exclude: ['e2e/**', '**/node_modules/**', '**/dist/**'],
  },
});
