/** The address of the game server, or null when it is not an http(s) address. */
export function cleanBase(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(text) ? text : null
}
