import { describe, it, expect } from 'vitest'
import {
  SWEEP_RULES,
  sweepDedupeKey,
  renderSweptTask,
  type SweepLead,
} from '@/lib/automation/task-sweep'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function lead(over: Partial<SweepLead> = {}): SweepLead {
  return {
    id: 'lead-1',
    name: 'Jane Doe',
    last_contacted_at: null,
    last_responded_at: null,
    created_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    ...over,
  }
}

function rule(key: string) {
  const r = SWEEP_RULES.find((x) => x.key === key)
  if (!r) throw new Error(`no rule ${key}`)
  return r
}

describe('sweepDedupeKey', () => {
  it('namespaces under sweep: so it cannot collide with allocation-engine keys', () => {
    // The allocation engine owns `inbound:<conv>` / `first_touch:<lead>`. If the
    // sweep ever minted one of those, the two producers would dedupe onto each
    // other's rows and reconcile() would close tasks it does not own.
    const key = sweepDedupeKey('inbound_awaiting_reply', 'lead-9')
    expect(key).toBe('sweep:inbound_awaiting_reply:lead-9')
    expect(key.startsWith('inbound:')).toBe(false)
    expect(key.startsWith('first_touch:')).toBe(false)
  })

  it('is stable per (rule, lead) so re-running the sweep dedupes', () => {
    expect(sweepDedupeKey('engaged_gone_quiet', 'lead-1')).toBe(
      sweepDedupeKey('engaged_gone_quiet', 'lead-1')
    )
  })

  it('scopes per rule, so one lead can hold one task per condition', () => {
    expect(sweepDedupeKey('engaged_gone_quiet', 'lead-1')).not.toBe(
      sweepDedupeKey('ready_to_book_stale', 'lead-1')
    )
  })
})

/**
 * `human_tasks.title` is frozen at mint time while the lead underneath keeps
 * changing, so /tasks re-runs the rule against the live lead instead of trusting
 * the stored string. In prod this queue was showing patients as phone numbers
 * ("Re-engage -408 724-0003 — gone quiet"): the phone had been parsed into
 * `first_name` when the task was minted, and the later phone-name scrub cleaned
 * the lead but could not reach into the title.
 */
describe('renderSweptTask', () => {
  it('re-renders title and detail from the CURRENT lead, not the stored title', () => {
    const rendered = renderSweptTask('engaged_gone_quiet', lead({ name: 'Michael Marshall' }))
    expect(rendered?.title).toBe('Re-engage Michael Marshall — gone quiet')
    expect(rendered?.detail).toContain('Michael Marshall')
  })

  it('covers every rule in the book', () => {
    // A rule whose key is missing here would silently keep serving stale titles.
    for (const r of SWEEP_RULES) {
      expect(renderSweptTask(r.key, lead()), `rule ${r.key}`).not.toBeNull()
    }
  })

  it('returns null for tasks this rulebook did not mint', () => {
    // The allocation engine and post-call review write their own titles; the
    // caller must fall back to the stored string rather than blanking them.
    expect(renderSweptTask('call_review', lead())).toBeNull()
    expect(renderSweptTask(undefined, lead())).toBeNull()
    expect(renderSweptTask(null, lead())).toBeNull()
  })
})

describe('SWEEP_RULES', () => {
  it('every rule prefixes its dedupe key with its own key', () => {
    // sweepRule() reads existing tasks with `like 'sweep:<key>:%'`; a mismatch
    // would make it blind to its own rows and mint duplicates every 15 minutes.
    for (const r of SWEEP_RULES) {
      expect(sweepDedupeKey(r.key, 'lead-1')).toContain(`sweep:${r.key}:`)
    }
  })

  it('orders urgency so a waiting patient outranks a background nudge', () => {
    expect(rule('inbound_awaiting_reply').priority).toBe('urgent')
    expect(rule('ready_to_book_stale').priority).toBe('high')
    expect(rule('engaged_gone_quiet').priority).toBe('normal')
  })

  it('puts the lead name in every title', () => {
    for (const r of SWEEP_RULES) {
      expect(r.title(lead({ name: 'Jane Doe' }))).toContain('Jane Doe')
    }
  })
})

describe('due dates', () => {
  it('inbound_awaiting_reply is due one hour after the patient messaged', () => {
    const respondedAt = new Date(Date.now() - 30 * 60 * 1000) // 30m ago
    const due = rule('inbound_awaiting_reply').dueAt(
      lead({ last_responded_at: respondedAt.toISOString() })
    )
    expect(due).not.toBeNull()
    expect(new Date(due!).getTime()).toBe(respondedAt.getTime() + HOUR_MS)
  })

  it('inbound_awaiting_reply that is already stale reads as overdue, not future', () => {
    // Anchoring to the patient's message (not to sweep time) is what makes a
    // 3-day-old unanswered text show up overdue instead of resetting its clock
    // to "due in 1h" on every run.
    const due = rule('inbound_awaiting_reply').dueAt(
      lead({ last_responded_at: new Date(Date.now() - 3 * DAY_MS).toISOString() })
    )
    expect(new Date(due!).getTime()).toBeLessThan(Date.now())
  })

  it('inbound_awaiting_reply carries no deadline when the timestamp is missing', () => {
    expect(rule('inbound_awaiting_reply').dueAt(lead({ last_responded_at: null }))).toBeNull()
  })

  it('deliberating_due uses the date the closer actually promised', () => {
    const promised = new Date(Date.now() - 2 * DAY_MS).toISOString()
    expect(rule('deliberating_due').dueAt(lead({ closing_follow_up_at: promised }))).toBe(promised)
  })

  it('engaged_gone_quiet has no deadline — it is background work, not a clock', () => {
    expect(rule('engaged_gone_quiet').dueAt(lead())).toBeNull()
  })
})

describe('detail copy', () => {
  it('reports how long the patient has been waiting', () => {
    const detail = rule('inbound_awaiting_reply').detail(
      lead({ name: 'Jane Doe', last_responded_at: new Date(Date.now() - 3 * DAY_MS).toISOString() })
    )
    expect(detail).toContain('3d')
    expect(detail).toContain('Jane Doe')
  })

  it('falls back to created_at when a stale lead was never contacted', () => {
    const detail = rule('ready_to_book_stale').detail(
      lead({ last_contacted_at: null, created_at: new Date(Date.now() - 5 * DAY_MS).toISOString() })
    )
    expect(detail).toContain('5d')
  })
})
