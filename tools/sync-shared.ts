// The mod is installed from its own folder, so it cannot import ../shared. This copies the
// shared code into mod/hooks/shared/. Edit shared/, run `bun tools/sync-shared.ts`, commit both.
// shared/sync.test.ts fails when the copies are out of date.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export const FILES = ['scene.ts', 'lib.ts', 'types.ts', 'protocol.ts']
export const HEADER = '// GENERATED from /shared by tools/sync-shared.ts. Edit the original, not this copy.\n'

export const copyOf = (name: string): string => HEADER + readFileSync(new URL(`../shared/${name}`, import.meta.url), 'utf8')

if (import.meta.main) {
  const out = new URL('../mod/hooks/shared/', import.meta.url)
  mkdirSync(out, { recursive: true })
  for (const name of FILES) writeFileSync(new URL(name, out), copyOf(name))
  console.log(`copied ${FILES.join(', ')} to mod/hooks/shared/`)
}
