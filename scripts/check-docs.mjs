// Fails when the English and Chinese docs drift apart in structure, or a relative link or anchor is broken.
import fs from 'node:fs'
import path from 'node:path'

const PAIRS = [
  ['README.md', 'README.zh-TW.md'],
  ['docs/commands.md', 'docs/commands.zh-TW.md'],
]
const LINKED = [...PAIRS.flat(), 'docs/upgrading-run-v2.md']
const errors = []

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

/** Headings outside fenced code blocks. */
function headings(file) {
  const out = []
  let fence = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^```/.test(line)) {
      fence = !fence
      continue
    }
    const m = !fence && line.match(/^(#{1,6}) +(.+?) *$/)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

for (const [a, b] of PAIRS) {
  const la = headings(a).map((h) => h.level).join('')
  const lb = headings(b).map((h) => h.level).join('')
  if (la !== lb) errors.push(`${a} and ${b} have different heading structure (levels ${la} vs ${lb})`)
}

for (const file of LINKED) {
  let inFence = false
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence
    if (inFence) return
    for (const m of line.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = m[1] ? path.normalize(path.join(path.dirname(file), m[1])) : file
      if (!fs.existsSync(target)) {
        errors.push(`${file}:${i + 1} links to missing file ${m[1]}`)
        continue
      }
      if (m[2]) {
        const want = decodeURIComponent(m[2].slice(1))
        if (!headings(target).some((h) => slug(h.text) === want)) errors.push(`${file}:${i + 1} links to missing anchor ${m[1]}${m[2]}`)
      }
    }
  })
}

if (errors.length) {
  console.error(errors.map((e) => `  ${e}`).join('\n'))
  process.exit(1)
}
console.log('docs ok')
