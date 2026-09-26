import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const here = import.meta.dirname;
export default defineConfig({
  root: here,
  server: { port: 4328, proxy: { '/api': 'http://localhost:4327' } },
  plugins: [
    {
      name: 'reader-dev-path',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/reader.js') request.url = '/src/reader.ts';
          next();
        });
      },
    },
  ],
  build: {
    outDir: resolve(here, '../../dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: { app: resolve(here, 'index.html'), reader: resolve(here, 'src/reader.ts') },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'reader' ? 'reader.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
