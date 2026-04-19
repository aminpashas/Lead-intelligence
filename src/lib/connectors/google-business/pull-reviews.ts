/**
 * Google Business Profile — Reviews Pull
 *
 * Fetches reviews for a configured GBP location once a day, upserts them into
 * the `reviews` table (migration 025), runs Claude sentiment scoring on new ones,
 * and drafts a response. **Never auto-publishes** — staff approves drafts from
 * the dashboard.
 *
 * Brief reference: §3.5 — "Auto-draft review responses (never auto-post) — staff
 * reviews and approves from the admin UI."
 *
 * GBP API:
 *   List:  GET https://mybusiness.googleapis.com/v4/{accountName}/locations/{locationId}/reviews
 *   Reply: PUT  .../{accountName}/locations/{locationId}/reviews/{reviewId}/reply  (we don't call this — staff does)
 *
 * Per-org config (connector_configs.connector_type='google_reviews', .credentials):
 *   account_name      — e.g. accounts/123456
 *   location_id       — the GBP location ID portion (numeric)
 *   client_id         — OAuth2 client (reuses Google Ads client by default if not set)
 *   client_secret
 *   refresh_token
 *   place_id          — for outbound review requests (existing reviews.ts module)
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAiUsage } from '@/lib/ai/usage'

const GBP_API_BASE = 'https://mybusiness.googleapis.com/v4'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SENTIMENT_MODEL = 'claude-haiku-4-5'

export type GbpReviewsConfig = {
  account_name: string         // 'accounts/123456'
  location_id: string          // bare location id, e.g. '987654321'
  client_id: string
  client_secret: string
  refresh_token: string
}

type GbpReview = {
  reviewId: string
  reviewer?: { displayName?: string; profilePhotoUrl?: string }
  starRating?: 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE'
  comment?: string
  createTime: string
  updateTime?: string
  name: string                 // full resource path
  reviewReply?: { comment?: string; updateTime?: string }
}

const STAR_MAP: Record<string, number | null> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
  STAR_RATING_UNSPECIFIED: null,
}

/**
 * Pull reviews for one organization's GBP location and upsert them.
 * Returns counts for monitoring.
 */
export async function pullReviewsForOrg(
  supabase: SupabaseClient,
  organizationId: string,
  config: GbpReviewsConfig
): Promise<{ fetched: number; new: number; analyzed: number; drafted: number; error?: string }> {
  let accessToken: string
  try {
    accessToken = await getAccessToken(config)
  } catch (err) {
    return { fetched: 0, new: 0, analyzed: 0, drafted: 0, error: err instanceof Error ? err.message : 'oauth_failed' }
  }

  const url = `${GBP_API_BASE}/${config.account_name}/locations/${config.location_id}/reviews?pageSize=50`
  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch (err) {
    return { fetched: 0, new: 0, analyzed: 0, drafted: 0, error: err instanceof Error ? err.message : 'network_error' }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { fetched: 0, new: 0, analyzed: 0, drafted: 0, error: `gbp_${res.status}: ${text.slice(0, 200)}` }
  }

  const body = await res.json() as { reviews?: GbpReview[] }
  const reviews = body.reviews || []

  let newCount = 0
  let analyzed = 0
  let drafted = 0

  for (const review of reviews) {
    const externalId = review.reviewId || review.name
    if (!externalId) continue

    // Idempotent insert keyed on (organization_id, source, external_id) unique index.
    const { data: existing } = await supabase
      .from('reviews')
      .select('id, response_status')
      .eq('organization_id', organizationId)
      .eq('source', 'gbp')
      .eq('external_id', externalId)
      .maybeSingle()

    const baseRow = {
      organization_id: organizationId,
      source: 'gbp' as const,
      external_id: externalId,
      external_url: `https://search.google.com/local/reviews?placeid=${config.location_id}`,
      reviewer_name: review.reviewer?.displayName || null,
      reviewer_avatar_url: review.reviewer?.profilePhotoUrl || null,
      star_rating: STAR_MAP[review.starRating || 'STAR_RATING_UNSPECIFIED'] ?? null,
      review_text: review.comment || null,
      reviewed_at: review.createTime || null,
    }

    let reviewRowId: string

    if (!existing) {
      const { data: inserted, error: insErr } = await supabase
        .from('reviews')
        .insert(baseRow)
        .select('id')
        .single()
      if (insErr || !inserted) continue
      reviewRowId = inserted.id as string
      newCount++
    } else {
      reviewRowId = existing.id as string
      // Refresh basic fields in case the reviewer edited their review
      await supabase.from('reviews').update(baseRow).eq('id', reviewRowId)
    }

    // Sentiment + draft response only for new reviews with text content.
    // Don't redraft if staff has already published or declined.
    const shouldAnalyze = !existing && review.comment && review.comment.length > 10
    if (!shouldAnalyze) continue

    try {
      const result = await analyzeAndDraft({
        reviewerName: review.reviewer?.displayName || 'a patient',
        starRating: STAR_MAP[review.starRating || 'STAR_RATING_UNSPECIFIED'],
        text: review.comment || '',
      })

      await supabase
        .from('reviews')
        .update({
          sentiment: result.sentiment,
          sentiment_score: result.sentimentScore,
          topics: result.topics,
          sentiment_analyzed_at: new Date().toISOString(),
          draft_response: result.draftResponse,
          draft_response_at: new Date().toISOString(),
          draft_model: SENTIMENT_MODEL,
          response_status: 'drafted',
        })
        .eq('id', reviewRowId)

      analyzed++
      if (result.draftResponse) drafted++

      await recordAiUsage({
        supabase,
        organizationId,
        feature: 'sentiment_review',
        model: SENTIMENT_MODEL,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        metadata: { review_id: reviewRowId, source: 'gbp' },
      })
    } catch (err) {
      // Log but don't fail the pull — review row already saved with content.
      await recordAiUsage({
        supabase,
        organizationId,
        feature: 'sentiment_review',
        model: SENTIMENT_MODEL,
        tokensIn: 0,
        tokensOut: 0,
        succeeded: false,
        errorMessage: err instanceof Error ? err.message : 'unknown',
        metadata: { review_id: reviewRowId },
      })
    }
  }

  return { fetched: reviews.length, new: newCount, analyzed, drafted }
}

// ── helpers ────────────────────────────────────────────────────────────

async function getAccessToken(config: GbpReviewsConfig): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: config.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`gbp_oauth_${res.status}`)
  const data = await res.json()
  return data.access_token as string
}

const SENTIMENT_PROMPT = `You analyze patient reviews of a dental implant practice.

Return STRICT JSON with exactly these keys:
{
  "sentiment": "positive" | "neutral" | "negative",
  "sentiment_score": number,           // -1.00 to 1.00
  "topics": string[],                  // 1-5 short tags from this set: wait_time, staff_friendliness, doctor_skill, pain_management, results, pricing, scheduling, cleanliness, communication, financing, other
  "draft_response": string             // Practice's reply: warm, professional, ≤500 chars, no marketing-speak, never include pricing or guarantees
}

Rules for the draft_response:
- Address by first name if visible.
- Negative reviews: acknowledge specifically, apologize without admitting fault, offer to make it right offline ("call us at...").
- Positive reviews: thank specifically, mention the team member if named, no upsell.
- Never auto-promise a refund, free service, or compensation.
- No emojis.
- Never include URLs or pricing.`

async function analyzeAndDraft(params: {
  reviewerName: string
  starRating: number | null
  text: string
}): Promise<{
  sentiment: 'positive' | 'neutral' | 'negative'
  sentimentScore: number
  topics: string[]
  draftResponse: string
  tokensIn: number
  tokensOut: number
}> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const userMessage = [
    `Reviewer name: ${params.reviewerName}`,
    `Star rating: ${params.starRating ?? 'unknown'}`,
    `Review text:`,
    params.text,
  ].join('\n')

  const response = await anthropic.messages.create({
    model: SENTIMENT_MODEL,
    max_tokens: 600,
    system: SENTIMENT_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  })

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim()

  // Extract the JSON block defensively — the model may wrap with ```json fences.
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('sentiment_response_not_json')

  const parsed = JSON.parse(jsonMatch[0]) as {
    sentiment: 'positive' | 'neutral' | 'negative'
    sentiment_score: number
    topics: string[]
    draft_response: string
  }

  return {
    sentiment: parsed.sentiment,
    sentimentScore: parsed.sentiment_score,
    topics: parsed.topics || [],
    draftResponse: (parsed.draft_response || '').slice(0, 500),
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  }
}
