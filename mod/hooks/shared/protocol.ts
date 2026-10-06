// GENERATED from /shared by tools/sync-shared.ts. Edit the original, not this copy.
// What the mod and the server agree on, so that a server and a mod of different ages say so instead of failing
// in odd ways. The mod puts PROTOCOL in the header `x-idlecrash-protocol` of every call; the server puts its own in
// every reply (`protocol`). A mod from before this had no header: it counts as 0, and so does a server with no `protocol`.
//
// Change PROTOCOL only when a mod and a server of different ages can no longer play together:
//   - the server drops something old mods use: raise PROTOCOL, and raise MIN_MOD_PROTOCOL to it;
//   - the mod needs something only a new server has: raise PROTOCOL, and raise MIN_SERVER_PROTOCOL to it.
// Anything else (a new look, a new rule that old mods can live with) leaves all three alone.
// shared/versions.test.ts checks that the numbers are in order.

export const PROTOCOL = 1

/** The oldest mod the server still serves. An older one is told to update (426, `mod-too-old`). */
export const MIN_MOD_PROTOCOL = 0

/** The oldest server the mod still works with. Against an older one the pane says the server is behind. */
export const MIN_SERVER_PROTOCOL = 0

export const PROTOCOL_HEADER = 'x-idlecrash-protocol'
