/**
 * Content Assets API — CRUD for practice content
 *
 * GET  — List assets for an org (optionally filtered by type)
 * POST — Create a new content asset
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAsset, getAssetsByType, updateAsset, deactivateAsset } from '@/lib/content/practice-assets'
import type { ContentAssetType } from '@/types/database'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const orgId = searchParams.get('organization_id')
  const type = searchParams.get('type') as ContentAssetType | null

  if (!orgId) {
    return NextResponse.json({ error: 'organization_id required' }, { status: 400 })
  }

  const supabase = getServiceClient()

  if (type) {
    const assets = await getAssetsByType(supabase, orgId, type)
    return NextResponse.json({ assets })
  }

  // Get all active assets for the org
  const { data: assets } = await supabase
    .from('practice_content_assets')
    .select('*')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .order('type')
    .order('usage_count', { ascending: false })

  return NextResponse.json({ assets: assets || [] })
}

export async function POST(request: NextRequest) {
  const body = await request.json()

  const { organization_id, type, title, description, content, media_urls, tags, created_by } = body

  if (!organization_id || !type || !title) {
    return NextResponse.json(
      { error: 'organization_id, type, and title are required' },
      { status: 400 }
    )
  }

  const validTypes: ContentAssetType[] = [
    'testimonial_video',
    'before_after_photo',
    'practice_info',
    'appointment_details',
    'financing_info',
    'procedure_info',
  ]

  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 }
    )
  }

  const supabase = getServiceClient()

  const asset = await createAsset(supabase, {
    organization_id,
    type,
    title,
    description,
    content: content || {},
    media_urls: media_urls || [],
    tags: tags || [],
    created_by,
  })

  if (!asset) {
    return NextResponse.json({ error: 'Failed to create asset' }, { status: 500 })
  }

  return NextResponse.json({ asset }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const body = await request.json()
  const { id, ...updates } = body

  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = getServiceClient()

  const asset = await updateAsset(supabase, id, updates)
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found or update failed' }, { status: 404 })
  }

  return NextResponse.json({ asset })
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = getServiceClient()
  await deactivateAsset(supabase, id)

  return NextResponse.json({ success: true })
}
