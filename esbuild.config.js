// LayoutSans — esbuild.config.js
// Bundles src/index.ts into:
//   dist/index.js   — ESM (for bundlers, Bun, Deno, modern Node)
//   dist/index.cjs  — CJS (for require()-based toolchains)
// Both builds are minified. @chenglou/pretext is excluded (peerDep = external).
// After bundling, prints gzipped sizes so we can verify the <25kB target.

import esbuild from 'esbuild'
import { gzipSync } from 'zlib'
import { readFileSync, mkdirSync } from 'fs'

mkdirSync('dist', { recursive: true })

const sharedOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  // Exclude peerDep — users supply their own Pretext install.
  // Also exclude Node built-ins in case esbuild resolves them.
  external: ['@chenglou/pretext'],
  target: ['es2020', 'node18'],
  logLevel: 'info',
}

// ── ESM build ─────────────────────────────────────────────────────────────────
await esbuild.build({
  ...sharedOptions,
  format: 'esm',
  outfile: 'dist/index.js',
})

// ── CJS build ─────────────────────────────────────────────────────────────────
await esbuild.build({
  ...sharedOptions,
  format: 'cjs',
  outfile: 'dist/index.cjs',
})

// ── Size report ───────────────────────────────────────────────────────────────
function gzipSize(path) {
  const buf = readFileSync(path)
  return gzipSync(buf).length
}

const esmGz = gzipSize('dist/index.js')
const cjsGz = gzipSize('dist/index.cjs')

const fmt = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

console.log('\n── Bundle sizes (gzipped) ──────────────────────────────')
console.log(`  dist/index.js   (ESM) : ${fmt(esmGz)}`)
console.log(`  dist/index.cjs  (CJS) : ${fmt(cjsGz)}`)

const target = 25 * 1024
const largest = Math.max(esmGz, cjsGz)
if (largest > target) {
  console.warn(`\n  ⚠️  Largest bundle (${fmt(largest)}) exceeds 25 kB target!`)
} else {
  console.log(`\n  ✓  Within 25 kB target (largest: ${fmt(largest)})`)
}
console.log('────────────────────────────────────────────────────────\n')
