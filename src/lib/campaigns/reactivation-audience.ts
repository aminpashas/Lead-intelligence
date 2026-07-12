/**
 * Reactivation template audiences.
 *
 * Each pre-built reactivation template implicitly targets a segment of the
 * lead database ("leads who went cold 30+ days ago", "leads marked lost", …).
 * This module makes that audience explicit by mapping every template ID to a
 * SmartListCriteria, so the template cards can preview — like a Smart List —
 * exactly which leads the campaign would apply to.
 *
 * Criteria are computed at call time because several are relative to "now"
 * (e.g. last contacted more than 30 days ago).
 */

import type { SmartListCriteria } from '@/types/database'

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

/** Statuses a lead can hold while still being a live re-engagement target
 *  (pre-close, not terminal, not already in treatment). */
const STALLED_STATUSES = ['new', 'contacted', 'qualified', 'unresponsive', 'dormant']

export function getTemplateAudienceCriteria(templateId: string): SmartListCriteria | null {
  switch (templateId) {
    case 'cold-lead-revival':
      // "Went cold 30+ days ago": still-open leads with no touch in 30 days.
      // created_before keeps brand-new uncontacted leads out of the segment —
      // they belong to speed-to-lead, not reactivation.
      return {
        statuses: STALLED_STATUSES,
        last_contacted_before: daysAgoIso(30),
        created_before: daysAgoIso(30),
      }

    case 'lost-lead-winback':
      return { statuses: ['lost'] }

    case 'no-show-recovery-plus':
      return { statuses: ['no_show'] }

    case 'database-reactivation-blitz':
      // Bulk-database sweeps: everything already flagged dormant/unresponsive.
      return { statuses: ['dormant', 'unresponsive'] }

    case 'vip-re-engagement':
      // High-value dormant leads only — the AI already scored them hot/warm.
      return {
        statuses: ['dormant', 'unresponsive', 'no_show', 'lost'],
        ai_qualifications: ['hot', 'warm'],
      }

    default:
      return null
  }
}
