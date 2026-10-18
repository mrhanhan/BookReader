import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    server: 'src/server.ts',
    'cli/create-admin': 'src/cli/create-admin.ts',
    // Separate executable so metadata parsing runs with its own heap and
    // lifetime instead of inside the API process.
    'books/metadata-worker': 'src/books/metadata-worker.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  // @bookr/shared's package entry points at TypeScript sources, which Node
  // cannot load at runtime; bundle it (and its uuid dependency) into the output.
  noExternal: ['@bookr/shared'],
  // Native or file-loading dependencies must resolve from node_modules.
  external: ['argon2', '@napi-rs/canvas', 'pdfjs-dist'],
});
