import type { FeedbackSentiment } from '@/types/database'

export function classifyFeedback(
  rating: number,
  promoterThreshold: number
): { sentiment: FeedbackSentiment; routedToReview: boolean } {
  const sentiment: FeedbackSentiment = rating >= 4 ? 'positive' : rating === 3 ? 'neutral' : 'negative'
  return { sentiment, routedToReview: rating >= promoterThreshold }
}

/** Unguessable public token for the /feedback/[token] page. */
export function generateFeedbackToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  // base64url without padding
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
