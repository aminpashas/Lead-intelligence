/**
 * Phone Validation via Twilio Lookup v2
 *
 * Validates phone numbers, detects line type (mobile/landline/VoIP),
 * and retrieves carrier information.
 */

import twilio from 'twilio'
import { withRetry, RETRY_CONFIGS } from '@/lib/retry'
import type { PhoneValidationResult } from './types'

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!)
}

export async function validatePhone(phone: string): Promise<PhoneValidationResult> {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return {
      valid: false,
      line_type: 'unknown',
      carrier: null,
      caller_name: null,
      country_code: 'US',
      national_format: null,
    }
  }

  const client = getTwilioClient()

  const result = await withRetry(async () => {
    return client.lookups.v2.phoneNumbers(phone).fetch({
      fields: 'line_type_intelligence,caller_name',
    })
  }, RETRY_CONFIGS.twilio)

  const lineTypeInfo = result.lineTypeIntelligence as Record<string, unknown> | null
  const callerNameInfo = result.callerName as Record<string, unknown> | null

  const rawType = String(lineTypeInfo?.type || '').toLowerCase()
  let lineType: PhoneValidationResult['line_type']
  switch (rawType) {
    case 'mobile':
      lineType = 'mobile'
      break
    case 'landline':
    case 'fixedline':
      lineType = 'landline'
      break
    case 'voip':
    case 'nonFixedVoip':
      lineType = 'voip'
      break
    case 'tollfree':
      lineType = 'toll_free'
      break
    default:
      lineType = 'unknown'
  }

  return {
    valid: result.valid ?? true,
    line_type: lineType,
    carrier: (lineTypeInfo?.carrier_name as string) || null,
    caller_name: (callerNameInfo?.caller_name as string) || null,
    country_code: result.countryCode || 'US',
    national_format: result.nationalFormat || null,
  }
}

export function phoneValidationConfidence(result: PhoneValidationResult): number {
  if (!result.valid) return 0.0
  switch (result.line_type) {
    case 'mobile':
      return 1.0
    case 'landline':
      return 0.8
    case 'voip':
      return 0.5
    case 'toll_free':
      return 0.3
    default:
      return 0.6
  }
}
