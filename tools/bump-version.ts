// One version for the mod, the marketplace, the server and the repo: `bun tools/bump-version.ts 0.3.2`.
// Then write the changelog entry (## 0.3.2). shared/versions.test.ts fails if a file was missed or there is no entry.
import { readFileSync, writeFileSync } from 'node:fs'

const next = process.argv[2] ?? ''
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: bun tools/bump-version.ts <major.minor.patch>')
  process.exit(1)
}

for (const file of ['package.json', 'server/package.json', 'mod/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  const url = new URL(`../${file}`, import.meta.url)
  const text = readFileSync(url, 'utf8')
  // Only the "version" lines: the files keep their own layout.
  const out = text.replace(/("version": ")[^"]+(")/g, `$1${next}$2`)
  writeFileSync(url, out)
  console.log(`${file} -> ${next}`)
}
