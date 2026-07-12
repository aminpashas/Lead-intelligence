import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    // jsdom's CSS chain (cssstyle → @asamuzakjp/css-color) require()s ESM-only
    // @csstools packages. That needs require(esm), which is flag-gated below
    // Node 20.19/22.12 — without it the jsdom worker dies at startup and the
    // file's tests silently never run. The flag is accepted (default-on) on
    // Node versions where require(esm) is already stable.
    execArgv: ['--experimental-require-module'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
