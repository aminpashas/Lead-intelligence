/**
 * Environment variable validation.
 * Validates required env vars at import time so errors surface immediately
 * rather than at runtime when a missing key causes a cryptic failure.
 */

type EnvVar = {
  key: string
  required: boolean
  description: string
}

const ENV_VARS: EnvVar[] = [
  // Supabase
  { key: 'NEXT_PUBLIC_SUPABASE_URL', required: true, description: 'Supabase project URL' },
  { key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true, description: 'Supabase anonymous key' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', required: false, description: 'Supabase service role key (needed for webhooks/cron)' },

  // AI
  { key: 'ANTHROPIC_API_KEY', required: false, description: 'Anthropic API key for Claude AI' },

  // Messaging
  { key: 'TWILIO_ACCOUNT_SID', required: false, description: 'Twilio Account SID' },
  { key: 'TWILIO_AUTH_TOKEN', required: false, description: 'Twilio Auth Token' },
  { key: 'TWILIO_PHONE_NUMBER', required: false, description: 'Twilio phone number for SMS' },
  { key: 'RESEND_API_KEY', required: false, description: 'Resend API key for email' },
  { key: 'RESEND_FROM_EMAIL', required: false, description: 'Resend sender email address' },

  // Voice (Retell AI)
  { key: 'RETELL_API_KEY', required: false, description: 'Retell AI API key for voice calling' },
  { key: 'RETELL_WEBHOOK_SECRET', required: false, description: 'Retell webhook signing secret' },

  // Security
  { key: 'WEBHOOK_SECRET', required: true, description: 'HMAC secret for webhook signature verification' },
  { key: 'ENCRYPTION_KEY', required: true, description: 'AES-256 key (64 hex chars) for PII field encryption — HIPAA requirement' },

  // App
  { key: 'NEXT_PUBLIC_APP_URL', required: false, description: 'Public app URL' },
]

export type EnvValidationResult = {
  valid: boolean
  missing: Array<{ key: string; description: string; required: boolean }>
  warnings: string[]
}

/**
 * Validate all environment variables and return a report.
 */
export function validateEnv(): EnvValidationResult {
  const missing: EnvValidationResult['missing'] = []
  const warnings: string[] = []

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.key]
    if (!value || value.trim() === '') {
      missing.push({ key: envVar.key, description: envVar.description, required: envVar.required })
    }
  }

  // Service-specific warnings
  if (!process.env.WEBHOOK_SECRET) {
    warnings.push('WEBHOOK_SECRET not set — all webhook endpoints will reject requests (fail-closed)')
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY not set — AI scoring, engagement, and analysis will fail')
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    warnings.push('Twilio credentials not set — SMS sending and webhook validation will fail')
  }
  if (!process.env.RETELL_API_KEY) {
    warnings.push('RETELL_API_KEY not set — AI voice calling will be unavailable')
  }
  if (!process.env.RESEND_API_KEY) {
    warnings.push('RESEND_API_KEY not set — email sending will fail')
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    warnings.push('SUPABASE_SERVICE_ROLE_KEY not set — webhooks and cron jobs will use anon client (limited access)')
  }
  if (!process.env.ENCRYPTION_KEY) {
    warnings.push('ENCRYPTION_KEY not set — PII fields will be stored unencrypted (HIPAA risk)')
  }

  const requiredMissing = missing.filter((m) => m.required)

  return {
    valid: requiredMissing.length === 0,
    missing,
    warnings,
  }
}

/**
 * Log environment validation results at startup.
 * Call this in your app's initialization.
 */
export function logEnvValidation(): void {
  const result = validateEnv()

  if (result.missing.length > 0) {
    const requiredMissing = result.missing.filter((m) => m.required)
    const optionalMissing = result.missing.filter((m) => !m.required)

    if (requiredMissing.length > 0) {
      console.error('❌ REQUIRED environment variables missing:')
      for (const m of requiredMissing) {
        console.error(`   ${m.key} — ${m.description}`)
      }
    }

    if (optionalMissing.length > 0) {
      console.warn('⚠️  Optional environment variables not set:')
      for (const m of optionalMissing) {
        console.warn(`   ${m.key} — ${m.description}`)
      }
    }
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.warn(`⚠️  ${w}`)
    }
  }

  if (result.valid && result.missing.length === 0) {
    console.log('✅ All environment variables configured')
  }
}

/**
 * Get a required environment variable or throw a clear error.
 */
export function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}
