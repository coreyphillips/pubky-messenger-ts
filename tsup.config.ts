import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Keep runtime deps external; consumers resolve them.
  external: [
    '@synonymdev/pubky',
    '@noble/curves',
    '@noble/hashes',
    '@noble/ciphers',
    '@scure/bip39',
  ],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
