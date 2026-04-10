/**
 * Email Validation via ZeroBounce API
 *
 * Validates email deliverability, detects disposable/free providers,
 * and provides domain intelligence.
 */

import { withRetry } from '@/lib/retry'
import type { EmailValidationResult } from './types'

const ZEROBOUNCE_API_URL = 'https://api.zerobounce.net/v2/validate'

const RETRY_CONFIG = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 }

export async function validateEmail(email: string): Promise<EmailValidationResult> {
  const apiKey = process.env.ZEROBOUNCE_API_KEY
  if (!apiKey) {
    return {
      status: 'unknown',
      sub_status: 'api_key_not_configured',
      free_email: false,
      disposable: false,
      did_you_mean: null,
      domain: email.split('@')[1] || null,
      domain_age_days: null,
      smtp_provider: null,
      mx_found: false,
    }
  }

  const url = `${ZEROBOUNCE_API_URL}?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`

  const response = await withRetry(async () => {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const err = new Error(`ZeroBounce API error: ${res.status}`) as Error & { status: number }
      err.status = res.status
      throw err
    }
    return res.json()
  }, RETRY_CONFIG)

  return mapZeroBounceResponse(response)
}

function mapZeroBounceResponse(data: Record<string, unknown>): EmailValidationResult {
  const status = String(data.status || '').toLowerCase()
  const subStatus = String(data.sub_status || '')

  let mappedStatus: EmailValidationResult['status']
  switch (status) {
    case 'valid':
      mappedStatus = 'valid'
      break
    case 'invalid':
      mappedStatus = 'invalid'
      break
    case 'catch-all':
      mappedStatus = 'catch-all'
      break
    case 'spamtrap':
      mappedStatus = 'spamtrap'
      break
    case 'abuse':
      mappedStatus = 'abuse'
      break
    case 'do_not_mail':
      mappedStatus = 'do_not_mail'
      break
    default:
      mappedStatus = 'unknown'
  }

  return {
    status: mappedStatus,
    sub_status: subStatus || null,
    free_email: data.free_email === true || data.free_email === 'true',
    disposable: subStatus === 'disposable' || data.disposable === true,
    did_you_mean: (data.did_you_mean as string) || null,
    domain: (data.domain as string) || null,
    domain_age_days: typeof data.domain_age_days === 'number' ? data.domain_age_days : null,
    smtp_provider: (data.smtp_provider as string) || null,
    mx_found: data.mx_found === true || data.mx_found === 'true',
  }
}

export function emailValidationConfidence(result: EmailValidationResult): number {
  switch (result.status) {
    case 'valid':
      return result.disposable ? 0.4 : 1.0
    case 'catch-all':
      return 0.6
    case 'invalid':
    case 'spamtrap':
    case 'abuse':
    case 'do_not_mail':
      return 0.0
    default:
      return 0.3
  }
}
