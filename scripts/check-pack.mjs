// Fails when the npm tarball holds anything but the built CLI, package.json, the READMEs and the LICENSE.
import { execFileSync } from 'node:child_process'

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
const files = JSON.parse(out)[0].files.map((f) => f.path)
const allowed = /^(dist\/.+\.(js|d\.ts)|package\.json|README(\.zh-TW)?\.md|LICENSE)$/

const extra = files.filter((p) => !allowed.test(p))
if (extra.length) {
  console.error(`pack has files that should not be published:\n${extra.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
if (!files.includes('dist/cli.js')) {
  console.error('pack is missing dist/cli.js (run `npm run build` first)')
  process.exit(1)
}
console.log(`pack ok: ${files.length} files`)
