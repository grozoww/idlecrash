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
