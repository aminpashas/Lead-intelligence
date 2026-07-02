/**
 * One-off: set Amin's test lead email to aminpashas@gmail.com (encrypted at rest,
 * with search hash) so email auto-responses/tests actually reach his inbox.
 * email_consent is already true on this lead.
 *
 * Usage: npx tsx scripts/set-amin-email.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { encryptLeadPII } from '../src/lib/encryption'

const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b'
const EMAIL = 'aminpashas@gmail.com'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  // encryptLeadPII encrypts the email field and computes email_hash.
  const enc = encryptLeadPII({ email: EMAIL }) as { email: string; email_hash?: string }
  const { error } = await supabase
    .from('leads')
    .update({ email: enc.email, email_hash: enc.email_hash })
    .eq('id', LEAD_ID)
  if (error) throw error
  console.log('Set email on lead', LEAD_ID, '→', EMAIL, '(encrypted; hash set:', !!enc.email_hash, ')')
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
