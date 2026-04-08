import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Pause campaign
  await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('id', id)

  // Pause all active enrollments
  await supabase
    .from('campaign_enrollments')
    .update({ status: 'paused' })
    .eq('campaign_id', id)
    .eq('status', 'active')

  return NextResponse.json({ success: true })
}
