import { build } from 'esbuild';

await build({
  entryPoints: ['src/anthropicExtension.ts'],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/extension.js',
  sourcemap: true,
  sourcesContent: false
});
