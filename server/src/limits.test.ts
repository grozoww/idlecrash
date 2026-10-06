import { expect, test } from 'bun:test'
import { HourlyLimit, clientKey } from './limits'

test('an IPv4 address is its own client, an IPv6 address is its /64', () => {
  expect(clientKey('203.0.113.7')).toBe('203.0.113.7')
  expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64')
  expect(clientKey('2001:DB8:1:2:ffff::')).toBe(clientKey('2001:db8:1:2::9')) // same /64, however it is written
  expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1')) // the next /64 is another client
})

test('short forms and zones', () => {
  expect(clientKey('2001:db8::1')).toBe('2001:0db8:0000:0000::/64')
  expect(clientKey('2001:db8:1:2::')).toBe('2001:0db8:0001:0002::/64')
  expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64')
  expect(clientKey('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64')
})

test('an IPv4 client seen through an IPv6 socket is still that IPv4 client', () => {
  expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
  expect(clientKey('::ffff:cb00:7107')).toBe('203.0.113.7')
})

test('what is not an IP is left alone', () => {
  expect(clientKey('unknown')).toBe('unknown')
})

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
