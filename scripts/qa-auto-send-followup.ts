/**
 * QA: auto-send a single AI-tailored follow-up EMAIL to the Amin test lead,
 * HARD-GATED to TEST_SEND_ALLOWLIST (refuses any other recipient).
 *
 * Demonstrates the "auto-send follow-up" path end-to-end: generate → gate → send
 * via the real consent-gated `sendEmailToLead`. SMS is intentionally NOT used
 * (US A2P 10DLC gate blocks it until the campaign is verified).
 *
 * Usage: npx tsx scripts/qa-auto-send-followup.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { decryptField } from '../src/lib/encryption'
import { buildSafeLeadContext } from '../src/lib/ai/hipaa'
import { sendEmailToLead } from '../src/lib/messaging/resend'

const LEAD_ID = '62e839ba-90ea-4e77-bcb8-68d5172a2e6b' // Amin Samadian test lead (Dion Health SF)

function allowlist(): string[] {
  return (process.env.TEST_SEND_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', LEAD_ID)
    .single()
  if (error || !lead) throw new Error(`Lead not found: ${error?.message}`)

  const email = (decryptField(lead.email) || lead.email || '').toString()
  console.log('Lead:', lead.first_name, lead.last_name, '· email:', email, '· email_consent:', lead.email_consent)

  // ── HARD ALLOWLIST GATE ────────────────────────────────────────
  const list = allowlist()
  if (!list.includes(email.toLowerCase())) {
    console.error(`❌ ABORT: ${email} is NOT in TEST_SEND_ALLOWLIST (${list.join(', ')}). No send.`)
    process.exit(1)
  }
  console.log('✅ recipient is allowlisted — proceeding')

  // Record the owner's explicit opt-in for this QA test lead — they requested
  // this send to their own address (mirrors add-test-patient.ts self-opt-in).
  await supabase
    .from('leads')
    .update({
      email_consent: true,
      email_consent_at: new Date().toISOString(),
      email_consent_source: 'self_opt_in_qa_auto_send',
      email_opt_out: false,
      email_consent_status: 'granted',
    })
    .eq('id', LEAD_ID)
  console.log('✅ recorded email opt-in for the test lead (self_opt_in_qa_auto_send)')

  // ── Generate an AI-tailored follow-up (HIPAA-safe context) ─────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const safeContext = buildSafeLeadContext(lead as Record<string, unknown>)
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system:
      'You are a warm, professional dental implant patient coordinator writing a brief follow-up email to re-engage a lead. Under 120 words. No pricing claims, no medical guarantees, no PHI. Invite them to book a free consultation. Return ONLY JSON: {"subject": "...", "body": "..."}',
    messages: [{ role: 'user', content: `Lead context:\n${safeContext}\n\nWrite the follow-up email.` }],
  })
  const text = resp.content[0].type === 'text' ? resp.content[0].text : ''
  const json = text.match(/\{[\s\S]*\}/)
  if (!json) throw new Error('AI did not return JSON')
  const { subject, body } = JSON.parse(json[0]) as { subject: string; body: string }
  console.log('\n── Generated follow-up ──\nSubject:', subject, '\n' + body + '\n')

  const html = body
    .split(/\n\n+/)
    .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('\n')

  // ── Send through the real consent-gated path ───────────────────
  const result = await sendEmailToLead({
    supabase,
    leadId: LEAD_ID,
    to: email,
    subject,
    html,
    text: body,
    from: 'onboarding@resend.dev', // Resend test sender — works without a verified domain
    aiGenerated: true,
    caller: 'qa.auto-send-followup',
  })

  if (result.sent) {
    console.log('✅ SENT — auto-follow-up email delivered to', email)
  } else {
    console.error('❌ NOT SENT — reason:', result.reason)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e)
  process.exit(1)
})
