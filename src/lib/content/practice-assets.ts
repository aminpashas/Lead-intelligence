/**
 * Practice Content Assets — CRUD & Retrieval
 *
 * Manages practice-specific content that AI agents can send to leads:
 * testimonial videos, before/after photos, practice info, procedure overviews, etc.
 *
 * Each asset belongs to an organization and can be tagged for contextual retrieval
 * by the AI during conversations.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentAsset, ContentAssetType } from '@/types/database'

// ═══════════════════════════════════════════════════════════════
// RETRIEVAL
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch all active assets of a given type for an organization.
 */
export async function getAssetsByType(
  supabase: SupabaseClient,
  organizationId: string,
  type: ContentAssetType
): Promise<ContentAsset[]> {
  const { data } = await supabase
    .from('practice_content_assets')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('type', type)
    .eq('is_active', true)
    .order('usage_count', { ascending: false })

  return (data || []) as ContentAsset[]
}

/**
 * Fetch a single asset by ID.
 */
export async function getAssetById(
  supabase: SupabaseClient,
  assetId: string
): Promise<ContentAsset | null> {
  const { data } = await supabase
    .from('practice_content_assets')
    .select('*')
    .eq('id', assetId)
    .single()

  return (data as ContentAsset) || null
}

/**
 * Fetch random assets of a type (for variety in AI responses).
 * Returns up to `limit` assets, randomly ordered.
 */
export async function getRandomAssets(
  supabase: SupabaseClient,
  organizationId: string,
  type: ContentAssetType,
  limit: number = 3
): Promise<ContentAsset[]> {
  // Supabase doesn't support random ordering natively via JS API,
  // so we fetch all and shuffle client-side (dataset is small per-org)
  const allAssets = await getAssetsByType(supabase, organizationId, type)
  if (allAssets.length <= limit) return allAssets

  // Fisher-Yates shuffle
  const shuffled = [...allAssets]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, limit)
}

/**
 * Search assets by tags or keywords in title/description.
 */
export async function searchAssets(
  supabase: SupabaseClient,
  organizationId: string,
  query: string,
  type?: ContentAssetType
): Promise<ContentAsset[]> {
  let qb = supabase
    .from('practice_content_assets')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_active', true)

  if (type) {
    qb = qb.eq('type', type)
  }

  // Search in title and description
  qb = qb.or(`title.ilike.%${query}%,description.ilike.%${query}%`)

  const { data } = await qb.limit(10)
  return (data || []) as ContentAsset[]
}

/**
 * Get the practice info asset (singleton per org — address, hours, etc.)
 */
export async function getPracticeInfo(
  supabase: SupabaseClient,
  organizationId: string
): Promise<ContentAsset | null> {
  const assets = await getAssetsByType(supabase, organizationId, 'practice_info')
  return assets[0] || null
}

// ═══════════════════════════════════════════════════════════════
// MUTATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new content asset.
 */
export async function createAsset(
  supabase: SupabaseClient,
  asset: {
    organization_id: string
    type: ContentAssetType
    title: string
    description?: string
    content: Record<string, unknown>
    media_urls?: string[]
    tags?: string[]
    created_by?: string
  }
): Promise<ContentAsset | null> {
  const { data } = await supabase
    .from('practice_content_assets')
    .insert({
      organization_id: asset.organization_id,
      type: asset.type,
      title: asset.title,
      description: asset.description || null,
      content: asset.content,
      media_urls: asset.media_urls || [],
      tags: asset.tags || [],
      created_by: asset.created_by || null,
    })
    .select('*')
    .single()

  return (data as ContentAsset) || null
}

/**
 * Update an existing content asset.
 */
export async function updateAsset(
  supabase: SupabaseClient,
  assetId: string,
  updates: Partial<{
    title: string
    description: string | null
    content: Record<string, unknown>
    media_urls: string[]
    tags: string[]
    is_active: boolean
  }>
): Promise<ContentAsset | null> {
  const { data } = await supabase
    .from('practice_content_assets')
    .update(updates)
    .eq('id', assetId)
    .select('*')
    .single()

  return (data as ContentAsset) || null
}

/**
 * Soft-delete an asset (deactivate).
 */
export async function deactivateAsset(
  supabase: SupabaseClient,
  assetId: string
): Promise<void> {
  await supabase
    .from('practice_content_assets')
    .update({ is_active: false })
    .eq('id', assetId)
}

/**
 * Increment usage count when an asset is sent to a lead.
 */
export async function incrementUsage(
  supabase: SupabaseClient,
  assetId: string
): Promise<void> {
  try {
    await supabase.rpc('increment_asset_usage', { asset_id: assetId })
  } catch {
    // Fallback: manual increment
    const { data } = await supabase
      .from('practice_content_assets')
      .select('usage_count')
      .eq('id', assetId)
      .single()
    if (data) {
      await supabase
        .from('practice_content_assets')
        .update({ usage_count: ((data as { usage_count: number }).usage_count || 0) + 1 })
        .eq('id', assetId)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// DELIVERY TRACKING
// ═══════════════════════════════════════════════════════════════

/**
 * Record a cross-channel delivery triggered by the AI agent.
 */
export async function recordDelivery(
  supabase: SupabaseClient,
  delivery: {
    organization_id: string
    lead_id: string
    conversation_id: string
    triggered_by_channel: string
    delivered_via_channel: string
    content_type: string
    content_asset_id?: string
    message_id?: string
    status: 'pending' | 'sent' | 'delivered' | 'failed'
    error_message?: string
    agent_type?: string
    tool_name?: string
    metadata?: Record<string, unknown>
  }
): Promise<string | null> {
  const { data } = await supabase
    .from('cross_channel_deliveries')
    .insert({
      organization_id: delivery.organization_id,
      lead_id: delivery.lead_id,
      conversation_id: delivery.conversation_id,
      triggered_by_channel: delivery.triggered_by_channel,
      delivered_via_channel: delivery.delivered_via_channel,
      content_type: delivery.content_type,
      content_asset_id: delivery.content_asset_id || null,
      message_id: delivery.message_id || null,
      status: delivery.status,
      error_message: delivery.error_message || null,
      agent_type: delivery.agent_type || null,
      tool_name: delivery.tool_name || null,
      metadata: delivery.metadata || {},
    })
    .select('id')
    .single()

  return data?.id || null
}

/**
 * Get cross-channel deliveries for a conversation (for timeline display).
 */
export async function getConversationDeliveries(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase
    .from('cross_channel_deliveries')
    .select('*, content_asset:practice_content_assets(title, type)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })

  return (data || []) as Array<Record<string, unknown>>
}
