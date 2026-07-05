/**
 * PATCH /api/agency/invoices/[id] — agency super-admin transitions an invoice's status.
 *
 * Lifecycle: draft → issued (visible to the practice) → paid, or → void. Agency-admin only.
 * 'mark_paid' stamps paid_at. Issuing a void/paid invoice is disallowed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile } from '@/lib/auth/active-org'

const bodySchema = z.object({ action: z.enum(['issue', 'void', 'mark_paid']) })

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: profile } = await getOwnProfile(supabase, 'role')
  if (!profile || profile.role !== 'agency_admin') {
    return NextResponse.json({ error: 'Forbidden — agency access required' }, { status: 403 })
  }

  let action: 'issue' | 'void' | 'mark_paid'
  try {
    action = bodySchema.parse(await request.json()).action
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (action === 'issue') patch.status = 'issued'
  if (action === 'void') patch.status = 'void'
  if (action === 'mark_paid') {
    patch.status = 'paid'
    patch.paid_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('usage_invoices')
    .update(patch)
    .eq('id', id)
    .select('id, status')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Failed to update invoice' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: data.id, status: data.status })
}
