/**
 * Re-match sweep — link already-synced CareStack patients back to marketing leads.
 *
 * `match.ts` only runs matching when a patient FIRST syncs, and never re-runs
 * (staff may have hand-corrected a link). But most patients synced before their
 * lead existed / was hashed, so the roster is full of `lead_id = null` patients
 * that *would* match a lead today. That's why only 13 of 61k patients link to a
 * lead. This sweep re-attempts the high-confidence hash matches in bulk.
 *
 * Efficiency: loads every lead's (email_hash, phone_hash) into memory once, then
 * pages the unlinked patients and does O(1) lookups — no per-row DB round-trips.
 * Only email_hash (conf 1.0) and phone_hash (conf 0.9) are used here; name+dob
 * (medium confidence, needs uniqueness) stays in the first-sync matcher only.
 *
 * Identity guards (attribution feeds ad spend + Google/Meta conversions, so a
 * wrong link is costly):
 *   - Ambiguous hashes are skipped: a hash mapping to >1 distinct LEAD can't be
 *     resolved, so we never guess.
 *   - Shared phone numbers are skipped: a phone that appears on >1 unlinked
 *     PATIENT is a household/placeholder/practice line, not an identity key
 *     (one junk number linked 59 patients to a single lead in prod). Phone
 *     matches only when that phone belongs to exactly one patient.
 *   - Email is highly identifying, so it's accepted as long as it's unambiguous.
 *
 * Idempotent + safe: only ever fills a NULL lead_id — never overwrites an
 * existing link (respects manual corrections). Dry-run reports counts only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type RematchResult = {
  resource: 'lead_patient_rematch'
  status: 'success' | 'failed'
  patients_scanned: number
  newly_matched: number
  by_email: number
  by_phone: number
  dry_run: boolean
  error?: string
}

export async function rematchUnlinkedPatients(
  supabase: SupabaseClient,
  organizationId: string,
  opts: { dryRun?: boolean } = {}
): Promise<RematchResult> {
  const dryRun = !!opts.dryRun
  try {
    // 1. Index every lead by its hashes. Track ambiguity: a hash that maps to
    //    more than one distinct lead can't be resolved, so mark it unusable.
    const emailToLead = new Map<string, string>()
    const phoneToLead = new Map<string, string>()
    const ambiguousEmail = new Set<string>()
    const ambiguousPhone = new Set<string>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('leads')
        .select('id, email_hash, phone_hash')
        .eq('organization_id', organizationId)
        .range(from, from + 999)
      if (error) throw new Error(`leads read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const l of data) {
        const id = l.id as string
        const eh = l.email_hash as string | null
        const ph = l.phone_hash as string | null
        if (eh) {
          const seen = emailToLead.get(eh)
          if (seen === undefined) emailToLead.set(eh, id)
          else if (seen !== id) ambiguousEmail.add(eh)
        }
        if (ph) {
          const seen = phoneToLead.get(ph)
          if (seen === undefined) phoneToLead.set(ph, id)
          else if (seen !== id) ambiguousPhone.add(ph)
        }
      }
      if (data.length < 1000) break
    }

    // 2. Load the unlinked patients (with a hash) into memory so we can count
    //    how many patients share each phone before deciding what to link.
    type Cand = { id: string; email_hash: string | null; phone_hash: string | null }
    const candidates: Cand[] = []
    const phonePatientCount = new Map<string, number>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('patients')
        .select('id, email_hash, phone_hash')
        .eq('organization_id', organizationId)
        .is('lead_id', null)
        .or('email_hash.not.is.null,phone_hash.not.is.null')
        .range(from, from + 999)
      if (error) throw new Error(`patients read failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const p of data) {
        const c: Cand = { id: p.id as string, email_hash: (p.email_hash as string) ?? null, phone_hash: (p.phone_hash as string) ?? null }
        candidates.push(c)
        if (c.phone_hash) phonePatientCount.set(c.phone_hash, (phonePatientCount.get(c.phone_hash) ?? 0) + 1)
      }
      if (data.length < 1000) break
    }

    // 3. Decide links, applying the identity guards.
    const scanned = candidates.length
    let byEmail = 0
    let byPhone = 0
    const updates: Array<{ id: string; lead_id: string; method: string; confidence: number }> = []

    for (const c of candidates) {
      // Email first — highest confidence — as long as it's unambiguous.
      if (c.email_hash && !ambiguousEmail.has(c.email_hash)) {
        const leadId = emailToLead.get(c.email_hash)
        if (leadId) {
          updates.push({ id: c.id, lead_id: leadId, method: 'email_hash', confidence: 1.0 })
          byEmail++
          continue
        }
      }
      // Phone — only when unambiguous AND the number belongs to exactly one
      // unlinked patient (shared/junk numbers are not identity).
      if (c.phone_hash && !ambiguousPhone.has(c.phone_hash) && phonePatientCount.get(c.phone_hash) === 1) {
        const leadId = phoneToLead.get(c.phone_hash)
        if (leadId) {
          updates.push({ id: c.id, lead_id: leadId, method: 'phone_hash', confidence: 0.9 })
          byPhone++
        }
      }
    }

    if (!dryRun) {
      for (const u of updates) {
        // Guard on lead_id IS NULL so a concurrent write never gets clobbered.
        const { error } = await supabase
          .from('patients')
          .update({ lead_id: u.lead_id, match_method: u.method, match_confidence: u.confidence })
          .eq('id', u.id)
          .is('lead_id', null)
        if (error) throw new Error(`patient ${u.id} relink failed: ${error.message}`)
      }
    }

    return {
      resource: 'lead_patient_rematch',
      status: 'success',
      patients_scanned: scanned,
      newly_matched: updates.length,
      by_email: byEmail,
      by_phone: byPhone,
      dry_run: dryRun,
    }
  } catch (e) {
    return {
      resource: 'lead_patient_rematch',
      status: 'failed',
      patients_scanned: 0,
      newly_matched: 0,
      by_email: 0,
      by_phone: 0,
      dry_run: dryRun,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
