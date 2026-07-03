/**
 * Publish the Full Mouth Reconstruction (FMR) contract template for ONE practice org.
 *
 * Idempotent: inserts a new template version for the slug (bumping version like the
 * API route does), publishes it, and archives any previously-published version for
 * that slug (the DB enforces one published template per org+slug).
 *
 * Optionally seeds organizations.settings.practice (doctor/coordinator/emergency
 * phone/default location) so the FMR merge fields resolve to real values. Without
 * it, those render blank and appear in the generated contract's missing_variables.
 *
 * ⚠️ This writes patient-facing legal copy to production. Only run once the
 *    [LEGAL REVIEW] items in docs/fmr-contract/FMR-Contract-Corrected-Master.md are
 *    confirmed by counsel.
 *
 * Required env:
 *   FMR_ORG_ID                    practice organization id (uuid)
 *   NEXT_PUBLIC_SUPABASE_URL      supabase url
 *   SUPABASE_SERVICE_ROLE_KEY     service role key
 *
 * Optional (settings.practice) — only written when provided:
 *   FMR_DOCTOR_NAME               e.g. "Dr. Amin Samadian, DDS"
 *   FMR_COORDINATOR_NAME          e.g. "Yolie Valencia"
 *   FMR_COORDINATOR_PHONE         e.g. "(415) 421-2144"
 *   FMR_COORDINATOR_EMAIL         e.g. "yvalencia@dionhealth.com"
 *   FMR_EMERGENCY_PHONE           after-hours line
 *   FMR_DEFAULT_LOCATION          e.g. "San Francisco"
 *
 * Flags:
 *   --dry-run                     print what would change; write nothing
 *   --draft-only                  insert the template but leave it in 'draft'
 *
 * Usage:  npx tsx scripts/seed-fmr-template.ts [--dry-run] [--draft-only]
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { FMR_TEMPLATE_SEED, FMR_TEMPLATE_SLUG } from '../src/lib/contracts/templates/fmr'

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}
const opt = (name: string): string | undefined => process.env[name] || undefined

const DRY_RUN = process.argv.includes('--dry-run')
const DRAFT_ONLY = process.argv.includes('--draft-only')

async function main() {
  const orgId = req('FMR_ORG_ID')
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Optionally seed settings.practice so FMR people/logistics merge fields resolve.
  const practicePatch: Record<string, string> = {}
  for (const [env, key] of [
    ['FMR_DOCTOR_NAME', 'doctor_name'],
    ['FMR_COORDINATOR_NAME', 'coordinator_name'],
    ['FMR_COORDINATOR_PHONE', 'coordinator_phone'],
    ['FMR_COORDINATOR_EMAIL', 'coordinator_email'],
    ['FMR_EMERGENCY_PHONE', 'emergency_phone'],
    ['FMR_DEFAULT_LOCATION', 'default_location'],
  ] as const) {
    const val = opt(env)
    if (val) practicePatch[key] = val
  }

  if (Object.keys(practicePatch).length > 0) {
    const { data: orgRow, error: orgErr } = await supabase
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .single()
    if (orgErr) throw new Error(`read org settings: ${orgErr.message}`)
    const settings = (orgRow?.settings ?? {}) as Record<string, unknown>
    const practice = { ...(settings.practice as Record<string, unknown> | undefined), ...practicePatch }
    const nextSettings = { ...settings, practice }
    console.log('settings.practice →', practice)
    if (!DRY_RUN) {
      const { error } = await supabase.from('organizations').update({ settings: nextSettings }).eq('id', orgId)
      if (error) throw new Error(`write org settings: ${error.message}`)
      console.log('✓ organizations.settings.practice updated')
    }
  } else {
    console.log('· no FMR_* practice env set — skipping settings.practice (merge fields may render blank)')
  }

  // 2. Version bump for the slug (mirrors the contract-templates API route).
  const { data: existing } = await supabase
    .from('contract_templates')
    .select('id, version, status')
    .eq('organization_id', orgId)
    .eq('slug', FMR_TEMPLATE_SLUG)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextVersion = (existing?.version ?? 0) + 1

  const status = DRAFT_ONLY ? 'draft' : 'published'
  console.log(`FMR template "${FMR_TEMPLATE_SEED.slug}" v${nextVersion} → ${status} (${FMR_TEMPLATE_SEED.sections.length} sections)`)

  if (DRY_RUN) {
    console.log('· dry run — nothing written')
    return
  }

  // 3. Insert the new version.
  const { data: inserted, error: insErr } = await supabase
    .from('contract_templates')
    .insert({
      organization_id: orgId,
      slug: FMR_TEMPLATE_SEED.slug,
      name: FMR_TEMPLATE_SEED.name,
      version: nextVersion,
      sections: FMR_TEMPLATE_SEED.sections,
      required_variables: FMR_TEMPLATE_SEED.required_variables,
      status: 'draft',
    })
    .select('id')
    .single()
  if (insErr) throw new Error(`insert template: ${insErr.message}`)
  console.log(`✓ inserted template ${inserted.id} (draft)`)

  if (DRAFT_ONLY) {
    console.log('· --draft-only — left in draft; publish from Settings → Contracts or re-run without the flag')
    return
  }

  // 4. Archive any currently-published version for this slug (unique published index).
  const { error: archErr } = await supabase
    .from('contract_templates')
    .update({ status: 'archived' })
    .eq('organization_id', orgId)
    .eq('slug', FMR_TEMPLATE_SEED.slug)
    .eq('status', 'published')
  if (archErr) throw new Error(`archive prior published: ${archErr.message}`)

  // 5. Publish the new version.
  const { error: pubErr } = await supabase
    .from('contract_templates')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', inserted.id)
  if (pubErr) throw new Error(`publish template: ${pubErr.message}`)
  console.log(`✓ published FMR template ${inserted.id} v${nextVersion}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
