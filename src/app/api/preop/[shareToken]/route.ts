import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * Public pre-op instruction portal API — secured by UUID share token.
 *
 * GET  — fetch the rendered instructions (marks first view)
 * POST — patient acknowledges they have read the instructions
 */

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function findForm(shareToken: string) {
  const supabase = getServiceSupabase()
  const { data: form } = await supabase
    .from('preop_forms')
    .select('id, organization_id, clinical_case_id, title, content, status, share_token_expires_at, first_viewed_at, acknowledged_at, acknowledged_name')
    .eq('share_token', shareToken)
    .neq('status', 'voided')
    .maybeSingle()
  return { supabase, form }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const { supabase, form } = await findForm(shareToken)
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (form.share_token_expires_at && new Date(form.share_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This link has expired' }, { status: 410 })
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('name, phone')
    .eq('id', form.organization_id)
    .single()

  if (!form.first_viewed_at) {
    await supabase
      .from('preop_forms')
      .update({
        first_viewed_at: new Date().toISOString(),
        ...(form.status === 'sent' ? { status: 'viewed' } : {}),
      })
      .eq('id', form.id)
  }

  return NextResponse.json({
    form: {
      title: form.title,
      content: form.content,
      status: form.status,
      acknowledged_at: form.acknowledged_at,
      acknowledged_name: form.acknowledged_name,
    },
    organization: org ? { name: org.name, phone: org.phone } : null,
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shareToken: string }> }
) {
  const { shareToken } = await params
  const { supabase, form } = await findForm(shareToken)
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (form.share_token_expires_at && new Date(form.share_token_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This link has expired' }, { status: 410 })
  }

  const body = await request.json().catch(() => ({}))
  const name = String(body.name ?? '').trim().slice(0, 200)
  if (!name) return NextResponse.json({ error: 'Please enter your name to confirm' }, { status: 400 })

  if (!form.acknowledged_at) {
    await supabase
      .from('preop_forms')
      .update({
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
        acknowledged_name: name,
      })
      .eq('id', form.id)
  }

  return NextResponse.json({ success: true })
}
