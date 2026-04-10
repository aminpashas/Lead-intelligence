/**
 * IP Geolocation via MaxMind GeoIP2 Web API
 *
 * Resolves IP addresses to geographic location, detects proxies/VPNs,
 * and calculates distance to practice location.
 */

import { withRetry } from '@/lib/retry'
import type { IPGeolocationResult } from './types'

const MAXMIND_API_URL = 'https://geolite.info/geoip/v2.1/city'
const RETRY_CONFIG = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 }

export async function geolocateIP(
  ip: string,
  practiceLocation?: { lat: number; lng: number }
): Promise<IPGeolocationResult> {
  const accountId = process.env.MAXMIND_ACCOUNT_ID
  const licenseKey = process.env.MAXMIND_LICENSE_KEY

  if (!accountId || !licenseKey) {
    return emptyResult(ip)
  }

  // Skip private/reserved IPs
  if (isPrivateIP(ip)) {
    return { ...emptyResult(ip), city: 'Private Network', country: 'Unknown' }
  }

  const auth = Buffer.from(`${accountId}:${licenseKey}`).toString('base64')

  const data = await withRetry(async () => {
    const res = await fetch(`${MAXMIND_API_URL}/${encodeURIComponent(ip)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const err = new Error(`MaxMind API error: ${res.status}`) as Error & { status: number }
      err.status = res.status
      throw err
    }
    return res.json()
  }, RETRY_CONFIG)

  const lat = data?.location?.latitude ?? null
  const lng = data?.location?.longitude ?? null

  let distanceMiles: number | null = null
  if (lat && lng && practiceLocation) {
    distanceMiles = haversineDistanceMiles(
      practiceLocation.lat,
      practiceLocation.lng,
      lat,
      lng
    )
  }

  return {
    ip,
    city: data?.city?.names?.en ?? null,
    region: data?.subdivisions?.[0]?.names?.en ?? null,
    country: data?.country?.iso_code ?? null,
    postal_code: data?.postal?.code ?? null,
    latitude: lat,
    longitude: lng,
    timezone: data?.location?.time_zone ?? null,
    isp: data?.traits?.isp ?? null,
    is_proxy: data?.traits?.is_anonymous_proxy === true,
    is_vpn: data?.traits?.is_anonymous_vpn === true || data?.traits?.is_anonymous === true,
    distance_to_practice_miles: distanceMiles ? Math.round(distanceMiles * 10) / 10 : null,
  }
}

function emptyResult(ip: string): IPGeolocationResult {
  return {
    ip,
    city: null,
    region: null,
    country: null,
    postal_code: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    is_proxy: false,
    is_vpn: false,
    distance_to_practice_miles: null,
  }
}

function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 127) return true
  return false
}

/**
 * Haversine formula to calculate distance between two lat/lng points in miles.
 */
function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 3958.8 // Earth radius in miles
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

export function ipGeolocationConfidence(result: IPGeolocationResult): number {
  if (!result.city && !result.region) return 0.3
  if (result.is_proxy || result.is_vpn) return 0.2
  return result.country ? 0.85 : 0.5
}
