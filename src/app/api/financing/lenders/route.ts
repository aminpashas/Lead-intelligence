import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { updateLenderConfigsSchema } from '@/lib/validators/financing'
import { encryptCredentials } from '@/lib/financing/encryption-helpers'
import { LENDER_INFO } from '@/lib/financing/adapters'
import type { LenderSlug } from '@/lib/financing/types'

/**
 * GET /api/financing/lenders
 *
 * List the organization's financing lender configurations.
 * Used by the settings page to show lender setup status.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    }

    const { data: configs } = await supabase
      .from('financing_lender_configs')
      .select('id, lender_slug, display_name, is_active, priority_order, config, integration_type, updated_at')
      .eq('organization_id', profile.organization_id)
      .order('priority_order', { ascending: true })

    // Merge with static lender info (features, credential fields, etc.)
    const lenders = (configs || []).map(config => ({
      ...config,
      has_credentials: false, // We never expose whether credentials exist — load separately
      info: LENDER_INFO[config.lender_slug as LenderSlug] || null,
    }))

    // Check if credentials are configured (without exposing them)
    for (const lender of lenders) {
      const { data: fullConfig } = await supabase
        .from('financing_lender_configs')
        .select('credentials_encrypted')
        .eq('id', lender.id)
        .single()

      lender.has_credentials = !!fullConfig?.credentials_encrypted
    }

    return NextResponse.json({ lenders })
  } catch (error) {
    console.error('[financing/lenders GET] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/financing/lenders
 *
 * Update lender configurations (toggle active, set priority, update credentials).
 * Requires admin or owner role.
 */
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    }

    // Only admins and owners can modify lender settings
    if (!['admin', 'owner'].includes(profile.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    const body = await request.json()
    const validation = updateLenderConfigsSchema.safeParse(body)
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const organizationId = profile.organization_id
    const updates = validation.data.lenders

    for (const lenderUpdate of updates) {
      const updateData: Record<string, unknown> = {
        is_active: lenderUpdate.is_active,
        priority_order: lenderUpdate.priority_order,
        updated_at: new Date().toISOString(),
      }

      // Update non-secret config
      if (lenderUpdate.config) {
        updateData.config = lenderUpdate.config
      }

      // Encrypt and store credentials if provided
      if (lenderUpdate.credentials && Object.keys(lenderUpdate.credentials).length > 0) {
        updateData.credentials_encrypted = encryptCredentials(lenderUpdate.credentials as Record<string, string>)
      }

      await supabase
        .from('financing_lender_configs')
        .update(updateData)
        .eq('organization_id', organizationId)
        .eq('lender_slug', lenderUpdate.lender_slug)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[financing/lenders PUT] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
