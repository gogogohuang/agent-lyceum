import { defineConfig } from 'vitest/config'

// plugins/ tests import `claude-code/testing`, which only exists inside Claude Code.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'plugins/**'] },
})
