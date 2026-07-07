import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Static build of the browser chat demo in examples/web.
// `base: './'` keeps asset URLs relative so it works at any path, including a
// GitHub Pages project site (https://<user>.github.io/pubky-messenger-ts/).
export default defineConfig({
  root: fileURLToPath(new URL('./examples/web', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist-web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // Allow importing the library source from outside the vite root during dev.
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
});
