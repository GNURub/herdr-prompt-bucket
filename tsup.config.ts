import {defineConfig} from 'tsup';

export default defineConfig({
  entry: ['src/main.tsx'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  splitting: false,
  outDir: 'dist',
});
