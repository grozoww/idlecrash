import { MIN_SERVER_PROTOCOL } from './shared/protocol'

/** The address of the game server, or null when it is not an http(s) address. */
export function cleanBase(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(text) ? text : null
}

/** How the mod and the server differ in age: the server will not serve this mod, or the mod needs a newer server. */
export type Skew = 'mod-too-old' | 'server-too-old'

/**
 * Whether a reply says the mod and the server do not fit. Only the game server's own JSON counts: an error page from
 * the proxy while the server restarts says nothing about versions.
 */
export function skewOf(status: number, json: unknown, minServer: number = MIN_SERVER_PROTOCOL): Skew | null {
  const reply = json && typeof json === 'object' ? (json as { ok?: unknown; error?: unknown; protocol?: unknown }) : null
  if (!reply || typeof reply.ok !== 'boolean') return null
  if (status === 426 || reply.error === 'mod-too-old') return 'mod-too-old'
  // A server from before the protocol says nothing: that is 0.
  if (Number(reply.protocol ?? 0) < minServer) return 'server-too-old'
  return null
}

/** What the pane says about it. */
export function skewText(skew: Skew, base: string): string {
  return skew === 'mod-too-old'
    ? 'This mod is too old for the server. Update it with: claude plugin update idlecrash@grozoww-mods, then restart Claude Code.'
    : `The server at ${base} is older than this mod needs. Try again later.`
}
