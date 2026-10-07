import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// plugins/ tests import `claude-code/testing`, which only exists inside Claude Code; map it to vitest.
// Tests that need the real mod runtime must be named *.mod.test.ts so they stay out of this run.
export default defineConfig({
  resolve: {
    alias: { 'claude-code/testing': fileURLToPath(new URL('./test/shims/claude-code-testing.ts', import.meta.url)) },
  },
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'plugins/**/*.mod.test.ts'] },
})
