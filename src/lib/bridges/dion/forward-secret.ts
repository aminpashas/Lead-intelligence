/**
 * Shared-secret gate for LI's inbound bus receiver (/api/bus/receive) — the
 * symmetric mirror of Dion Clinical's lib/dion/forward-secret.ts.
 *
 * The hub fan-out signs each subscriber delivery with `x-forward-secret`
 * (hub's DION_BUS_FORWARD_SECRET ?? DION_BUS_SECRET, or a per-subscriber
 * `#secret`). LI checks it against DION_BUS_SECRET — the same machine secret LI
 * already uses on its OUTBOUND calls to Clinical — with an optional
 * DION_BUS_INBOUND_SECRET override for the case where the hub signs subscriber
 * deliveries with a distinct secret.
 *
 * SECURITY — fail closed. When no secret is configured we refuse (503) rather
 * than accept forged sibling events. Read at call time so tests / cold starts
 * see the current value.
 */
export type ForwardSecretResult =
  | { ok: true }
  | { ok: false; reason: 'unconfigured' | 'mismatch' }

/** The configured inbound secret(s), preferring a dedicated inbound override. */
function inboundSecrets(): string[] {
  const inbound = process.env.DION_BUS_INBOUND_SECRET?.trim()
  const shared = process.env.DION_BUS_SECRET?.trim()
  return [inbound, shared].filter((s): s is string => Boolean(s))
}

export function checkForwardSecret(header: string | null): ForwardSecretResult {
  const secrets = inboundSecrets()
  if (secrets.length === 0) return { ok: false, reason: 'unconfigured' }
  if (!header || !secrets.includes(header)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
