/**
 * POST /api/agency/invoices/[id]/send — email a usage invoice to the practice.
 *
 * Agency-admin only, and only fires on this explicit request (never automatically). Resolves the
 * practice's billing email (organizations.email, else an admin/owner profile), renders the invoice,
 * sends it via Resend, stamps sent_at/sent_via, and issues the invoice if it was still a draft
 * (sending implies issuing, which also makes it visible to the practice via RLS).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import {
  renderInvoiceEmailHtml,
  invoiceEmailSubject,
  type InvoiceEmailLineItem,
} from '@/lib/billing/invoice-email'

type DbLineItem = { service: string; quantity: number; unit: string; billableCents: number }

async function resolveBillingEmail(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<{ email: string; name: string } | null> {
  const { data: org } = await supabase
    .from('organizations')
    .select('name, email')
    .eq('id', organizationId)
    .maybeSingle()

  const name = (org?.name as string) ?? 'Your practice'
  if (org?.email) return { email: org.email as string, name }

  // Fall back to a practice admin/owner. user_profiles.email may be encrypted.
  const { data: admin } = await supabase
    .from('user_profiles')
    .select('email, role')
    .eq('organization_id', organizationId)
    .in('role', ['owner', 'admin', 'doctor_admin', 'office_manager'])
    .limit(1)
    .maybeSingle()

  const raw = admin?.email as string | undefined
  const email = raw ? decryptField(raw) || raw : null
  return email ? { email, name } : null
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  const { data: inv } = await supabase
    .from('usage_invoices')
    .select('id, organization_id, period_start, period_end, line_items, usage_billable_cents, platform_fee_cents, total_cents, status')
    .eq('id', id)
    .maybeSingle()

  if (!inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  if (inv.status === 'void') return NextResponse.json({ error: 'Cannot send a void invoice' }, { status: 409 })

  const recipient = await resolveBillingEmail(supabase, inv.organization_id as string)
  if (!recipient) {
    return NextResponse.json(
      { error: 'No billing email on file for this practice. Set one in the organization record.' },
      { status: 422 },
    )
  }

  const lineItems: InvoiceEmailLineItem[] = ((inv.line_items as DbLineItem[]) ?? []).map((li) => ({
    service: li.service,
    quantity: Number(li.quantity ?? 0),
    unit: li.unit,
    billableCents: Number(li.billableCents ?? 0),
  }))

  const emailData = {
    practiceName: recipient.name,
    periodStart: inv.period_start as string,
    periodEnd: inv.period_end as string,
    lineItems,
    usageBillableCents: Number(inv.usage_billable_cents ?? 0),
    platformFeeCents: Number(inv.platform_fee_cents ?? 0),
    totalCents: Number(inv.total_cents ?? 0),
  }

  try {
    await sendEmail({
      to: recipient.email,
      subject: invoiceEmailSubject(emailData),
      html: renderInvoiceEmailHtml(emailData),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to send invoice email' }, { status: 502 })
  }

  await supabase
    .from('usage_invoices')
    .update({
      sent_at: new Date().toISOString(),
      sent_via: `email:${recipient.email}`,
      // Sending implies issuing — make it visible to the practice if it was still a draft.
      status: inv.status === 'draft' ? 'issued' : inv.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  return NextResponse.json({ ok: true, sentTo: recipient.email })
}
