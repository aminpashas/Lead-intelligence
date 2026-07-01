import { describe, it, expect } from 'vitest'
import { classifyFeedback, generateFeedbackToken } from '@/lib/feedback/review-gating'

describe('classifyFeedback', () => {
  it('routes ratings at/above the threshold to the public review', () => {
    expect(classifyFeedback(5, 4)).toEqual({ sentiment: 'positive', routedToReview: true })
    expect(classifyFeedback(4, 4)).toEqual({ sentiment: 'positive', routedToReview: true })
  })
  it('keeps ratings below the threshold private', () => {
    expect(classifyFeedback(3, 4)).toEqual({ sentiment: 'neutral', routedToReview: false })
    expect(classifyFeedback(2, 4)).toEqual({ sentiment: 'negative', routedToReview: false })
    expect(classifyFeedback(1, 4)).toEqual({ sentiment: 'negative', routedToReview: false })
  })
})

describe('generateFeedbackToken', () => {
  it('produces distinct, URL-safe tokens', () => {
    const a = generateFeedbackToken(), b = generateFeedbackToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })
})
