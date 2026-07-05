/**
 * Prepaid usage-balance settlement + auto-reload.
 *
 * For each practice in `prepaid` billing mode: debit usage accrued since the last settlement from
 * the balance, then (if auto_reload is on and a card is on file) top up when the balance is at/below
 * the low threshold. Practices not in prepaid mode are untouched. Idempotent per run — the
 * settlement watermark advances so usage is never double-debited.
 *
 * Schedule: every 30 min (vercel.json). Reload fires off-session; a missing card is a no-op.
 */
import { withCron } from '@/lib/cron/with-cron'
import { settleUsageToBalance, reloadIfLow } from '@/lib/billing/balance'

export const POST = withCron('usage-balance', async ({ supabase }) => {
  const { data: prepaid } = await supabase
    .from('billing_settings')
    .select('organization_id')
    .eq('billing_mode', 'prepaid')

  const now = new Date()
  let settled = 0
  let reloaded = 0
  let failed = 0

  for (const p of prepaid ?? []) {
    const orgId = p.organization_id as string
    try {
      const s = await settleUsageToBalance(supabase, orgId, now)
      if (s.debitedCents > 0) settled++
      const r = await reloadIfLow(supabase, orgId)
      if (r.reloaded) reloaded++
      else if (r.reason && !['not_enabled', 'above_threshold', 'no_card_on_file'].includes(r.reason)) failed++
    } catch {
      failed++
    }
  }

  return {
    status: 'ok',
    items: settled,
    data: { practices: prepaid?.length ?? 0, settled, reloaded, failed },
  }
})
