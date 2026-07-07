import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', discovery: 'src/discovery/index.ts' },
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
    'hyperdht',
  ],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
