import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FILES, copyOf } from '../tools/sync-shared'

test('the mod carries up-to-date copies of the shared code (run: bun tools/sync-shared.ts)', () => {
  for (const name of FILES) {
    const copy = readFileSync(new URL(`../mod/hooks/shared/${name}`, import.meta.url), 'utf8')
    expect(copy).toBe(copyOf(name))
  }
})
