/**
 * Transcript normalization shared by every surface that renders a voice call
 * (the conversation-timeline CallCard and the Call Center expanded row).
 *
 * A Retell call can arrive two ways: a structured array of `{ role, content }`
 * turns, or a plain-text blob ("Agent: …\nUser: …"). Both collapse to the same
 * role-tagged line list so the UI only has to know one shape.
 */

export type TranscriptRole = 'agent' | 'lead'
export type TranscriptLine = { role: TranscriptRole; content: string }

/** A call object with just the transcript-bearing fields we read. */
type TranscriptSource = {
  transcript?: unknown
  transcript_summary?: string | null
}

const AGENT_PREFIX = /^(?:agent|ai|assistant)\s*:\s*(.*)$/i
const LEAD_PREFIX = /^(?:user|caller|lead|patient|customer)\s*:\s*(.*)$/i

/**
 * Parse a plain-text transcript into role-tagged lines. Continuation lines (no
 * speaker prefix) attach to the previous line; a blob with no prefixes at all
 * falls back to a single agent line.
 */
function parseText(raw: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    const agent = line.match(AGENT_PREFIX)
    const lead = line.match(LEAD_PREFIX)
    if (agent) {
      lines.push({ role: 'agent', content: agent[1] })
    } else if (lead) {
      lines.push({ role: 'lead', content: lead[1] })
    } else if (lines.length) {
      lines[lines.length - 1].content += `\n${line}`
    } else {
      lines.push({ role: 'agent', content: line })
    }
  }
  return lines
}

/** Map a structured turn's role onto our two-sided agent/lead split. */
function roleOf(role: unknown): TranscriptRole {
  return role === 'agent' || role === 'assistant' || role === 'ai' ? 'agent' : 'lead'
}

/**
 * Normalize whatever `call.transcript` holds into role-tagged lines. Returns an
 * empty array when there's no usable transcript.
 */
export function toTranscriptLines(call: TranscriptSource): TranscriptLine[] {
  const t = call.transcript
  if (Array.isArray(t)) {
    return (t as Array<{ role?: unknown; content?: unknown }>)
      .map((turn) => ({ role: roleOf(turn.role), content: String(turn.content ?? '').trim() }))
      .filter((l) => l.content.length > 0)
  }
  if (typeof t === 'string' && t.trim()) {
    return parseText(t)
  }
  return []
}
