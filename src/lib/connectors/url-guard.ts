/**
 * SSRF guard for user-configured outbound webhook URLs.
 *
 * Org admins can set an arbitrary destination URL for the custom-webhook
 * connector. Without validation, that URL could target the cloud metadata
 * endpoint (169.254.169.254), localhost, or internal services — turning the
 * connector into a server-side request forgery primitive.
 *
 * assertSafeWebhookUrl() requires HTTPS and rejects any host that is — or
 * resolves to — a private / loopback / link-local / metadata address.
 */

import dns from 'node:dns/promises'
import net from 'node:net'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/** True if the literal IP is in a private / loopback / link-local / reserved range. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true       // "this host", private, loopback
    if (a === 169 && b === 254) return true                 // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true        // private
    if (a === 192 && b === 168) return true                 // private
    if (a === 100 && b >= 64 && b <= 127) return true       // CGNAT (RFC 6598)
    if (a >= 224) return true                               // multicast / reserved
    return false
  }

  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80')) return true                 // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local
  if (lower.startsWith('::ffff:')) {                        // IPv4-mapped IPv6
    return isPrivateIp(lower.slice('::ffff:'.length))
  }
  return false
}

/**
 * Validate that a webhook URL is safe to fetch. Throws on anything that could
 * reach an internal/metadata address. Returns the parsed URL on success.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid webhook URL')
  }

  if (url.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS')
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Webhook URL host is not allowed')
  }

  // Literal IP host — check it directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Webhook URL points to a private address')
    return url
  }

  // Resolve and ensure EVERY resolved address is public.
  let addresses: string[]
  try {
    const resolved = await dns.lookup(host, { all: true })
    addresses = resolved.map((r) => r.address)
  } catch {
    throw new Error('Webhook URL host could not be resolved')
  }

  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new Error('Webhook URL resolves to a private address')
  }

  return url
}
