import { isIPv6 } from 'node:net'

/**
 * What the limits count as one client. An IPv4 address is one client. An IPv6 user holds a whole
 * /64, so every address inside it is the same client: otherwise a script could take a new address
 * for every request and never hit a limit. Anything that is not an IP (a proxy's odd header) stays as it is.
 */
export function clientKey(ip: string): string {
  const bare = ip.split('%')[0]! // drop a zone, as in fe80::1%eth0
  if (!isIPv6(bare)) return ip
  const [left = '', right = ''] = bare.split('::')
  const groups = (part: string): string[] =>
    part
      ? part.split(':').flatMap(g => {
          const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(g)
          return v4 ? [(+v4[1]! * 256 + +v4[2]!).toString(16), (+v4[3]! * 256 + +v4[4]!).toString(16)] : [g]
        })
      : []
  const l = groups(left)
  const r = groups(right)
  const all = [...l, ...Array<string>(Math.max(0, 8 - l.length - r.length)).fill('0'), ...r]
  const n = all.map(g => parseInt(g, 16))
  // An IPv4 client that reached us through an IPv6 socket (::ffff:1.2.3.4) is that IPv4 client.
  if (n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`
  return `${all.slice(0, 4).map(g => g.padStart(4, '0').toLowerCase()).join(':')}::/64`
}

/** At most `max` things per key per hour, remembered in memory. */
export class HourlyLimit {
  private seen = new Map<string, number[]>()

  constructor(private max: number) {}

  allow(key: string, now: number): boolean {
    const recent = (this.seen.get(key) ?? []).filter(t => t > now - 3600_000)
    if (recent.length >= this.max) {
      this.seen.set(key, recent)
      return false
    }
    recent.push(now)
    this.seen.set(key, recent)
    return true
  }

  /** Forgets keys with nothing recent, so the map does not grow for ever. */
  sweep(now: number): void {
    for (const [key, times] of this.seen) if (!times.some(t => t > now - 3600_000)) this.seen.delete(key)
  }

  get size(): number {
    return this.seen.size
  }
}
