import { redirect } from 'next/navigation'

/**
 * AI Audit lives in the Agency Control Panel. Send the user straight there —
 * the middleware already bounces non-agency roles from /agency back to
 * /dashboard, so no dead-end "go log in" stub is needed for a signed-in user.
 */
export default function AiAuditPracticePage() {
  redirect('/agency/ai-audit')
}
