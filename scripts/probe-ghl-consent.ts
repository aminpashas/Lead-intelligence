/**
 * READ-ONLY probe: what consent data does GHL actually expose per contact?
 *
 * Prints field KEYS, DND flags, and custom-field NAMES only — never contact
 * values (no PII/PHI in output). Does NOT write anything. Used to lock the
 * exact GHL opt-in field before building the consent import.
 *
 *   npx tsx scripts/probe-ghl-consent.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig, searchOpportunities, fetchPipelines, ghlFetch } from '../src/lib/ghl/client'

function req(n: string): string {
  const v = process.env[n]
  if (!v) { console.error(`Missing env: ${n}`); process.exit(1) }
  return v
}

const CONSENT_HINT = /(consent|opt.?in|sms|text|tcpa|subscrib|marketing|permission|dnd)/i

async function main() {
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))

  // Find an org with a GHL connector.
  const { data: conn } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)
    .limit(1)
    .maybeSingle()
  if (!conn) { console.error('No enabled ghl connector found'); process.exit(1) }
  const orgId = conn.organization_id as string
  console.log('GHL org:', orgId)

  const config = await getGhlConfig(supabase, orgId)
  if (!config) { console.error('getGhlConfig returned null (missing token/location?)'); process.exit(1) }

  // Custom-field DEFINITIONS (id -> name) live at the location level. This is
  // where we discover which opaque field id means "SMS consent / opt-in".
  console.log('\n=== custom field definitions (location) ===')
  for (const path of [`/locations/${config.locationId}/customFields`, `/custom-fields/`]) {
    try {
      const def = await ghlFetch<{ customFields?: Array<Record<string, unknown>> }>(config, path)
      const defs = def.customFields ?? (def as { customField?: Array<Record<string, unknown>> }).customField ?? []
      if (!Array.isArray(defs) || defs.length === 0) { console.log(`  ${path}: (none)`); continue }
      console.log(`  ${path}: ${defs.length} fields`)
      for (const f of defs) {
        const id = String(f.id ?? '?')
        const name = String(f.name ?? '')
        const fieldKey = String(f.fieldKey ?? '')
        const dtype = String(f.dataType ?? '')
        const hit = CONSENT_HINT.test(name) || CONSENT_HINT.test(fieldKey) ? '  <-- CONSENT?' : ''
        console.log(`    ${id}  "${name}"  [${fieldKey}] (${dtype})${hit}`)
      }
      break // first endpoint that works wins
    } catch (e) {
      console.log(`  ${path}: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Sample a handful of opportunities to get real contact ids.
  const pipelines = await fetchPipelines(config)
  const opps = await searchOpportunities(config, { pipelineId: pipelines[0]?.id ?? '', page: 1 })
  console.log(`\nfetched ${opps.length} opportunities (page 1)`)
  if (opps.length) {
    console.log('opportunity top-level keys:', Object.keys(opps[0] as Record<string, unknown>).sort().join(', '))
  }

  const contactIds = Array.from(
    new Set(opps.map((o) => (o as { contactId?: string }).contactId).filter(Boolean) as string[]),
  ).slice(0, 5)
  console.log(`\nprobing ${contactIds.length} contacts (keys/flags only, no values):`)

  for (const id of contactIds) {
    try {
      const res = await ghlFetch<{ contact?: Record<string, unknown> }>(config, `/contacts/${id}`)
      const c = (res.contact ?? res) as Record<string, unknown>
      const topKeys = Object.keys(c).sort()
      const consentKeys = topKeys.filter((k) => CONSENT_HINT.test(k))

      // Custom fields: dump field id + name + value TYPE only (never the value).
      const cf = (c.customFields ?? c.customField ?? []) as Array<Record<string, unknown>>
      const cfSummary = Array.isArray(cf)
        ? cf.map((f) => {
            const key = String(f.id ?? f.key ?? f.name ?? '?')
            const name = String(f.name ?? f.fieldKey ?? '')
            const hit = CONSENT_HINT.test(key) || CONSENT_HINT.test(name) ? ' <-- CONSENT?' : ''
            const present = f.value != null && f.value !== '' ? 'set' : 'empty'
            return `    ${key} "${name}" (${present})${hit}`
          })
        : ['    (customFields not an array)']

      console.log(`\n  contact ${id.slice(0, 6)}…`)
      console.log('    dnd:', c.dnd, '| dndSettings:', c.dndSettings ? Object.keys(c.dndSettings as object).join(',') : '—')
      console.log('    consent-looking top keys:', consentKeys.length ? consentKeys.join(', ') : '(none)')
      console.log('    customFields:')
      for (const line of cfSummary) console.log(line)
    } catch (e) {
      console.log(`  contact ${id.slice(0, 6)}… fetch failed:`, e instanceof Error ? e.message : e)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
