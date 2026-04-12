import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .update({ status: 'active', start_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', profile.organization_id) // Defense-in-depth: explicit org scoping
    .select()
    .single()

  if (error || !campaign) {
    return NextResponse.json({ error: error?.message || 'Campaign not found' }, { status: error ? 500 : 404 })
  }

  return NextResponse.json({ campaign })
}

