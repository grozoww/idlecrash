// The things that must not drift apart: the version in every file, the changelog, and the protocol numbers.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MIN_MOD_PROTOCOL, MIN_SERVER_PROTOCOL, PROTOCOL } from './protocol'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const json = (path: string): any => JSON.parse(read(path))

const version: string = json('mod/.claude-plugin/plugin.json').version // the release is made from this one

test('one version everywhere: the mod, the marketplace, the server and the repo', () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(json('package.json').version).toBe(version)
  expect(json('server/package.json').version).toBe(version)
  const entry = json('.claude-plugin/marketplace.json').plugins.find((p: any) => p.name === 'idlecrash')
  expect(entry.version).toBe(version)
})

test('the changelog has an entry for that version, and it is the newest one', () => {
  const heads = [...read('CHANGELOG.md').matchAll(/^## (\S+)\s*$/gm)].map(m => m[1])
  expect(heads[0]).toBe(version)
  // tools/release.sh makes the release notes from that entry: it must not be empty.
  const entry = read('CHANGELOG.md').split(/^## /m)[1]!.split('\n').slice(1).join('\n')
  expect(entry.trim().length).toBeGreaterThan(0)
})

test('the protocol numbers are in order', () => {
  for (const n of [PROTOCOL, MIN_MOD_PROTOCOL, MIN_SERVER_PROTOCOL]) expect(Number.isInteger(n) && n >= 0).toBe(true)
  // This repo's server and mod speak PROTOCOL: neither may ask for more than that of the other.
  expect(MIN_MOD_PROTOCOL).toBeLessThanOrEqual(PROTOCOL)
  expect(MIN_SERVER_PROTOCOL).toBeLessThanOrEqual(PROTOCOL)
})
