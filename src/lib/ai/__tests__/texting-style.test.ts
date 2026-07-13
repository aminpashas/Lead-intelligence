import { describe, it, expect } from 'vitest'
import {
  analyzeTextingStyle,
  classifyVerbosity,
  formatTextingStyleBlock,
} from '@/lib/ai/texting-style'

describe('classifyVerbosity', () => {
  it('buckets by average words per text', () => {
    expect(classifyVerbosity(1)).toBe('terse')
    expect(classifyVerbosity(3)).toBe('terse')
    expect(classifyVerbosity(6)).toBe('brief')
    expect(classifyVerbosity(15)).toBe('conversational')
    expect(classifyVerbosity(40)).toBe('talkative')
  })
})

describe('analyzeTextingStyle', () => {
  it('reads the terse short-texter from the screenshot', () => {
    // The real replies that triggered this: "soon", "my wife", "really bad",
    // "yes", "morning", "10 on Weds".
    const style = analyzeTextingStyle([
      'soon',
      'my wife',
      'really bad',
      'yes',
      'morning',
      '10 on Weds',
    ])
    expect(style.verbosity).toBe('terse')
    expect(style.avgWords).toBeLessThanOrEqual(3)
    expect(style.usesEmoji).toBe(false)
    expect(style.usesGreetings).toBe(false)
    expect(style.sampleSize).toBe(6)
  })

  it('reads a talkative patient who writes full messages', () => {
    const style = analyzeTextingStyle([
      "Hi there! I've been dealing with failing teeth for years and I'm finally ready to look into permanent options for my whole upper arch.",
      "My main worry is honestly the cost and whether financing would even be an option given my situation, so I'd love to understand that before booking anything.",
    ])
    expect(style.verbosity).toBe('talkative')
    expect(style.usesGreetings).toBe(true)
    expect(style.usesPunctuation).toBe(true)
    expect(style.lowercase).toBe(false)
  })

  it('detects a casual lowercase, emoji-using texter', () => {
    const style = analyzeTextingStyle(['yeah sounds good 😊', 'lol ok', 'sure thing'])
    expect(style.lowercase).toBe(true)
    expect(style.usesEmoji).toBe(true)
    expect(style.usesPunctuation).toBe(false)
  })

  it('unwraps the prompt-guard <user_message> wrapper on the newest turn', () => {
    const style = analyzeTextingStyle([
      'really bad',
      '<user_message>\nyes\n</user_message>',
    ])
    // "yes" should be measured as one word, not counted with wrapper tokens.
    expect(style.avgWords).toBeLessThanOrEqual(2)
    expect(style.verbosity).toBe('terse')
  })

  it('weights the recent window, not the whole thread', () => {
    // An early long message shouldn't keep classifying a now-terse lead as chatty.
    const longOpener = 'a '.repeat(30).trim()
    const style = analyzeTextingStyle(
      [longOpener, 'yes', 'ok', 'sure', 'morning', 'sounds good', 'yep'],
      6
    )
    expect(style.sampleSize).toBe(6) // dropped the opener
    expect(style.verbosity).toBe('terse')
  })

  it('returns unknown with no messages', () => {
    const style = analyzeTextingStyle([])
    expect(style.verbosity).toBe('unknown')
    expect(style.sampleSize).toBe(0)
  })
})

describe('formatTextingStyleBlock', () => {
  it('tells the agent to mirror hard for a terse texter and drop emoji', () => {
    const block = formatTextingStyleBlock(
      analyzeTextingStyle(['yes', 'really bad', 'soon', 'morning'])
    )
    expect(block).toContain("THIS PATIENT'S TEXTING STYLE")
    expect(block).toMatch(/MIRROR THEM HARD/)
    expect(block).toMatch(/don't use emoji, so you don't either/)
    expect(block).toMatch(/skip greetings/)
  })

  it('lets a talkative patient get warmer, more thorough replies', () => {
    const block = formatTextingStyleBlock(
      analyzeTextingStyle([
        "Hello, I'd really like to understand the full process here and what the recovery actually looks like day to day before I decide to commit to anything at all with you.",
        'It genuinely matters a lot to me that I feel comfortable with the doctor and the whole plan first, so I have a bunch of questions I want to walk through together.',
      ])
    )
    expect(block).toMatch(/they like to talk/)
  })

  it('gives a safe default before any inbound text exists', () => {
    const block = formatTextingStyleBlock(analyzeTextingStyle([]))
    expect(block).toMatch(/Open SHORT/)
  })
})
