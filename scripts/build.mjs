import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  packages: 'external', // keep esbuild/pkg/obfuscator/etc. as runtime deps
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
}

await build({
  ...shared,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.cjs',
  banner: { js: '#!/usr/bin/env node' },
})

await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
})

chmodSync('dist/cli.cjs', 0o755)
console.log('✓ built dist/cli.cjs and dist/index.cjs')
