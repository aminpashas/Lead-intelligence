import { describe, it, expect, vi } from 'vitest'
import { executeCampaignSteps } from '@/lib/campaigns/executor'

// The enrollment is the AI's send authorization (resolveActiveCampaignPolicy
// counts only status='active'), so an exit condition firing on reply must not
// revoke it for an AI-enabled campaign — it should stop the steps instead.

function makeDb(campaign: Record<string, unknown>) {
  const updates: { table: string; patch: Record<string, unknown> }[] = []

  const enrollment = {
    id: 'e1',
    lead_id: 'l1',
    organization_id: 'org1',
    campaign_id: 'c1',
    status: 'active',
    current_step: 0,
    created_at: '2026-07-21T00:00:00Z',
    next_step_at: '2026-07-21T01:00:00Z',
    campaign,
    lead: {
      id: 'l1',
      total_messages_received: 1,
      last_responded_at: '2026-07-21T02:00:00Z',
      phone: '+14155550100',
      phone_formatted: '+14155550100',
      email: null,
    },
  }

  const step = {
    id: 's1',
    campaign_id: 'c1',
    step_number: 1,
    channel: 'sms',
    exit_condition: { if_replied: true },
  }

  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {}
    const self = () => b
    for (const m of ['select', 'eq', 'lte', 'order', 'insert']) b[m] = vi.fn(self)
    b.update = vi.fn((patch: Record<string, unknown>) => {
      updates.push({ table, patch })
      return b
    })
    b.limit = vi.fn(() =>
      Promise.resolve({ data: table === 'campaign_enrollments' ? [enrollment] : [] })
    )
    b.single = vi.fn(() => {
      if (table === 'campaign_steps') return Promise.resolve({ data: step })
      if (table === 'campaign_enrollments') return Promise.resolve({ data: { id: 'e1' } }) // claim
      return Promise.resolve({ data: null })
    })
    return b
  })

  return { db: { from } as never, updates }
}

describe('executeCampaignSteps exit condition', () => {
  it('keeps the enrollment active (steps stopped) when an AI-enabled campaign lead replies', async () => {
    const { db, updates } = makeDb({ id: 'c1', ai_enabled: true, metadata: {}, organization_id: 'org1' })
    const results = await executeCampaignSteps(db, 'org1')

    expect(results).toHaveLength(1)
    expect(results[0].action).toBe('completed')

    const final = updates[updates.length - 1]
    expect(final.table).toBe('campaign_enrollments')
    expect(final.patch.next_step_at).toBeNull()
    expect(final.patch.status).toBeUndefined()
  })

  it('still exits the enrollment for a non-AI campaign', async () => {
    const { db, updates } = makeDb({ id: 'c1', ai_enabled: false, metadata: {}, organization_id: 'org1' })
    const results = await executeCampaignSteps(db, 'org1')

    expect(results).toHaveLength(1)
    expect(results[0].action).toBe('exited')

    const final = updates[updates.length - 1]
    expect(final.patch.status).toBe('exited')
  })
})
