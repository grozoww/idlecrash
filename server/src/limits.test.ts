import { expect, test } from 'bun:test'
import { HourlyLimit } from './limits'

test('lets max through per key per hour, then refuses, then forgets', () => {
  const limit = new HourlyLimit(3)
  const t = 1_000_000
  expect([1, 2, 3, 4].map(i => limit.allow('a', t + i))).toEqual([true, true, true, false])
  expect(limit.allow('b', t)).toBe(true) // another key has its own count
  expect(limit.allow('a', t + 3600_000 + 10)).toBe(true) // an hour later it is open again
})

test('sweeping drops quiet keys', () => {
  const limit = new HourlyLimit(1)
  limit.allow('a', 0)
  limit.allow('b', 0)
  limit.sweep(3600_000 + 1)
  expect(limit.size).toBe(0)
})
