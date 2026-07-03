/**
 * Provision the Twilio resources the browser softphone needs.
 *
 * The Voice WebRTC SDK requires two things your account doesn't have yet:
 *   1. An API Key/Secret pair — used to SIGN short-lived browser access tokens.
 *   2. A TwiML App — a named "voice URL" Twilio fetches when the browser places a
 *      call. We point it at /api/voice/twiml/outbound, which returns the <Dial>.
 *
 * This script creates both using your existing TWILIO_ACCOUNT_SID / AUTH_TOKEN,
 * then prints the three env vars to paste into .env.local (and Vercel).
 *
 * Run:  npx tsx scripts/provision-twilio-voice.ts
 *
 * Idempotency: it reuses an existing TwiML App with the same friendly name (so
 * re-running only updates its voice URL). API Keys can't be looked up by name and
 * their secret is shown only once, so a new key is minted each run — delete stale
 * ones in the Twilio console if you re-run.
 */

import { config } from 'dotenv'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import twilio from 'twilio'

// Next stores secrets in .env.local; load it explicitly (dotenv defaults to .env).
config({ path: resolve(process.cwd(), '.env.local') })

const APP_FRIENDLY_NAME = 'Lead Intelligence — Browser Softphone'
const KEY_FRIENDLY_NAME = 'Lead Intelligence — Voice Access Tokens'

/**
 * Upsert keys into .env.local WITHOUT printing secrets to stdout (this script's
 * output may be captured in logs/transcripts). Replaces any existing lines for the
 * given keys, else appends them.
 */
function writeEnvLocal(vars: Record<string, string>) {
  const path = resolve(process.cwd(), '.env.local')
  let contents = existsSync(path) ? readFileSync(path, 'utf8') : ''
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`
    const re = new RegExp(`^${key}=.*$`, 'm')
    contents = re.test(contents) ? contents.replace(re, line) : `${contents.replace(/\n?$/, '\n')}${line}\n`
  }
  writeFileSync(path, contents)
}

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) {
    console.error('❌ TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env.local')
    process.exit(1)
  }

  // The public URL Twilio will POST to when the browser device places a call.
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://YOUR-APP-DOMAIN'
  const voiceUrl = `${appUrl}/api/voice/twiml/outbound`
  if (appUrl.includes('YOUR-APP-DOMAIN')) {
    console.warn(
      '⚠️  NEXT_PUBLIC_APP_URL is not set — using a placeholder voice URL.\n' +
      `   Set the TwiML App voice URL to <your-domain>/api/voice/twiml/outbound before going live.\n`
    )
  }

  const client = twilio(accountSid, authToken)

  // ── 1. TwiML App (reuse by name, else create) ──────────────────────────────
  console.log('→ Looking for an existing TwiML App…')
  const existingApps = await client.applications.list({ friendlyName: APP_FRIENDLY_NAME, limit: 1 })
  let appSid: string
  if (existingApps.length > 0) {
    appSid = existingApps[0].sid
    await client.applications(appSid).update({ voiceUrl, voiceMethod: 'POST' })
    console.log(`  reused TwiML App ${appSid} (voice URL updated → ${voiceUrl})`)
  } else {
    const app = await client.applications.create({
      friendlyName: APP_FRIENDLY_NAME,
      voiceUrl,
      voiceMethod: 'POST',
    })
    appSid = app.sid
    console.log(`  created TwiML App ${appSid} → ${voiceUrl}`)
  }

  // ── 2. API Key/Secret (always mint fresh — secret shown once) ──────────────
  console.log('→ Creating a Voice API Key…')
  const key = await client.newKeys.create({ friendlyName: KEY_FRIENDLY_NAME })
  console.log(`  created API Key ${key.sid}`)

  // ── Output ─────────────────────────────────────────────────────────────────
  // Write straight to .env.local so the secret never prints to stdout/logs.
  writeEnvLocal({
    TWILIO_API_KEY: key.sid,
    TWILIO_API_SECRET: key.secret,
    TWILIO_TWIML_APP_SID: appSid,
  })

  console.log('\n✅ Wrote TWILIO_API_KEY / TWILIO_API_SECRET / TWILIO_TWIML_APP_SID to .env.local\n')
  console.log(`   TWILIO_API_KEY       = ${key.sid}`)
  console.log(`   TWILIO_TWIML_APP_SID = ${appSid}`)
  console.log('   TWILIO_API_SECRET    = (written to .env.local only — shown once by Twilio)\n')
  console.log('Next: copy these 3 vars from .env.local into your Vercel project env, then redeploy.')
  console.log('The API secret cannot be retrieved again — if you lose it, mint a new key.\n')
}

main().catch((err) => {
  console.error('❌ Provisioning failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
