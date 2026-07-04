# GHL Conversation-History Enrichment — Timelines, Call Records & Summaries

**Status:** Tier 1 IMPLEMENTED 2026-07-04 (on the committed backfill base); tsc clean, 18 unit tests pass.

## Implementation status
| Piece | State |
|---|---|
| Message + call timestamps (timeline) | ✅ already in base backfill |
| **Tier 1** — call duration / outcome / recording | ✅ implemented: `extractGhlCall` (conversations.ts) + enriched `lead_activities` metadata + outcome-aware `formatCallTitle` (ingest-message.ts) |
| **Step 0** — live GHL call-payload probe | ✅ script written: `scripts/ghl-probe-call-payload.ts` (run it to confirm/tighten field keys — needs env) |
| **Tier 2** — Claude call summarizer | ✅ module written: `src/lib/voice/call-summary.ts` (runs on any transcript text) |
| Tier 2 — STT of recordings | ⛔ BLOCKED: no STT provider in repo (only @anthropic-ai/sdk; Claude can't transcribe audio). Explicit seam `transcribeRecording()` — provision Whisper/Deepgram/AssemblyAI + key. |
| Tier 2 — summary cron over answered/long calls | ⬜ not built (pending STT + Step-0 confirmation that recordings/transcripts exist) |
| UI merge — calls in pre-call timeline | ⬜ not built (see UI section) |

**Design change from the schema probe:** the original recommendation to persist calls into `voice_calls` was
dropped — `voice_calls` has NOT NULL `from_number`/`to_number` (not available in the backfill context without
cross-file phone plumbing) and its `outcome` CHECK is *sales* outcomes, not call-connection states. Nothing
reads the existing `call_logged` activities except the writer, so **enriching `lead_activities` metadata** was
the safe, self-contained path taken. `voice_calls` remains a future option if numbers get threaded through.

---

**Coordination note (historical):** the base backfill files were being edited by another session while this
was drafted; they have since committed (`234af80`, `3e95ae6`, `553aa1d`) and Tier 1 was layered on top of the
clean tree.

---

## Goal

Before any AI/rep dials the 43,313 consented leads, the caller must see the lead's **real GHL history as a
timeline**: when each SMS/email was sent, when each call happened, the call **outcome + duration**, and —
where feasible — a **call summary**.

## Current state (what the WIP already does)

| Item | Status |
|---|---|
| SMS/email body + direction + **timestamp** | ✅ `messages.created_at = GHL dateAdded` |
| Call **timestamp** + direction | ✅ `lead_activities(call_logged).created_at` |
| `last_contacted_at` / `last_responded_at` recency | ✅ `recompute_*` w/ GREATEST |
| Call **duration / outcome / recording / summary** | ❌ dropped — `normalizeGhlMessage` discards `msg.meta` |
| Any GHL history actually imported | ❌ 0 messages (backfill never run) |

So **timelines are solved for messages and call *timing*.** The gap is **call richness** (duration, answered
vs voicemail vs missed, recording) and **summaries**.

---

## Design decision: persist GHL calls into `voice_calls`, not `lead_activities`

The current code files GHL calls as thin `lead_activities` rows (`activity_type='call_logged'`, title +
timestamp only). But `voice_calls` already has the right shape **and is already rendered** by the timeline
`CallCard` and the Call Center expanded row (see `src/lib/voice/transcript.ts`):

```
voice_calls: id, organization_id, lead_id, conversation_id, direction, status,
             duration_seconds, recording_url, transcript (jsonb), outcome,
             from_number, to_number, started_at, created_at, metadata (jsonb), consent_verified
```

**Recommendation:** write imported GHL calls into `voice_calls` with `metadata.source='ghl'` and
`metadata.ghl_message_id=<id>` (idempotency key). Then duration/outcome/recording/summary render in the
**same** UI as Retell calls, for free — no new call component, and the pre-call timeline is unified.

Keep a lightweight `lead_activities(call_logged)` row too **only if** other surfaces already read it;
otherwise retire it to avoid double-representing the same call.

**Dedup:** before insert, `select 1 from voice_calls where organization_id=$org and metadata->>'ghl_message_id'=$id`.
Mirror the idempotency the current `lead_activities` path uses.

**Not-null columns:** populate `from_number`/`to_number` from the GHL contact/location numbers,
`status`/`outcome` from the mapping below, `started_at = created_at = GHL dateAdded`, `consent_verified=false`
(imported history, not a fresh consent check).

---

## ⚠️ Step 0 — verify the GHL call payload FIRST

GHL's `TYPE_CALL` message shape varies by API revision. Before mapping, pull **one** real call message and log
its raw JSON:

```
GET /conversations/{conversationId}/messages   (Version: 2021-04-15)
```

Confirm the actual keys for: duration, call status/disposition, recording URL, and any transcript/summary.
Common shapes seen in the wild (treat as *candidates*, verify): `meta.call.duration`, `meta.call.status`,
top-level `attachments[]` for the recording, `meta.callDuration`, `status`. Extract **defensively** (read
several possible keys, fall back to null) rather than trusting one.

---

## Tier 1 — capture GHL call metadata (small; do with the backfill)

### 1a. `conversations.ts` — carry call fields through the normalizer

Extend the persist-ready shape and stop dropping `meta` for calls:

```ts
// GhlMessage already has `meta?: Record<string, unknown>` and may carry `attachments`.
export type GhlCallOutcome = 'answered' | 'no_answer' | 'voicemail' | 'busy' | 'failed' | 'unknown'

export type NormalizedGhlMessage = {
  externalId: string
  channel: NormalizedChannel
  direction: 'inbound' | 'outbound'
  body: string
  subject: string | null
  createdAt: string
  isCall: boolean
  // NEW — populated only when isCall:
  call?: {
    durationSec: number | null
    outcome: GhlCallOutcome
    recordingUrl: string | null
    /** raw provider payload, kept for audit + later re-parse */
    raw: Record<string, unknown> | null
  }
}

// Defensive extractor — adjust keys to match the Step-0 payload.
export function extractGhlCall(msg: GhlMessage): NonNullable<NormalizedGhlMessage['call']> {
  const meta = (msg.meta ?? {}) as Record<string, any>
  const call = (meta.call ?? meta) as Record<string, any>
  const durationSec =
    Number(call.duration ?? call.callDuration ?? meta.duration ?? 0) || null
  const rawStatus = String(call.status ?? call.callStatus ?? msg.status ?? '').toLowerCase()
  const outcome: GhlCallOutcome =
    /voicemail|vm/.test(rawStatus) ? 'voicemail'
    : /no[-_ ]?answer|missed|noanswer/.test(rawStatus) ? 'no_answer'
    : /busy/.test(rawStatus) ? 'busy'
    : /answer|complet|connect/.test(rawStatus) ? 'answered'
    : /fail|error/.test(rawStatus) ? 'failed'
    : 'unknown'
  const attachments = (msg as any).attachments as unknown[] | undefined
  const recordingUrl =
    (call.recordingUrl as string) ??
    (Array.isArray(attachments) ? (attachments.find(a => /\.(mp3|wav|m4a)/i.test(String(a))) as string) : null) ??
    null
  return { durationSec, outcome, recordingUrl: recordingUrl || null, raw: (meta ?? null) as any }
}
```

In `normalizeGhlMessage`, when `isCall`, attach `call: extractGhlCall(msg)`.

### 1b. persist path — write the rich call into `voice_calls`

Replace the thin `lead_activities` insert (or add alongside) with:

```ts
if (n.isCall) {
  const ghlId = n.externalId.replace(/^ghl_msg:/, '')
  const dupe = await supabase.from('voice_calls').select('id')
    .eq('organization_id', organizationId)
    .filter('metadata->>ghl_message_id', 'eq', ghlId).limit(1).maybeSingle()
  if (dupe.data) return { status: 'skipped' }

  await supabase.from('voice_calls').insert({
    organization_id: organizationId,
    lead_id: lead.id,
    direction: n.direction,
    status: 'completed',                       // it's historical; outcome carries the nuance
    outcome: n.call?.outcome ?? 'unknown',
    duration_seconds: n.call?.durationSec ?? null,
    recording_url: n.call?.recordingUrl ?? null,
    started_at: n.createdAt,
    created_at: n.createdAt,
    consent_verified: false,
    metadata: { source: 'ghl', ghl_message_id: ghlId, raw_call: n.call?.raw ?? null },
  })
  return { status: 'call_logged' }
}
```

Outcome-aware label for any list view: `"Outbound · voicemail · 0:08"`, `"Inbound · answered · 4:12"`.

---

## Tier 2 — call summaries (real build; gate hard)

**Be honest about the stack:** `src/lib/voice/transcript.ts` only *normalizes/renders* a transcript — it is
**not** a speech-to-text engine, and Claude cannot transcribe audio. Historical GHL **recordings** therefore
need an actual STT step.

Decision tree per imported call:

1. **GHL already returns a transcript/summary** (confirm in Step 0) → store transcript in
   `voice_calls.transcript` (normalize via `toTranscriptLines`), summary in `metadata.ai_summary`. Done, cheap.
2. **Only a recording URL** → transcribe, then summarize:
   - **STT:** call an STT provider on `recording_url` (Whisper / Deepgram / AssemblyAI — pick one; LI's live
     path uses Retell which won't transcribe an arbitrary URL). New small module `src/lib/voice/transcribe-url.ts`.
   - **Summary:** Claude (`claude-sonnet-5` per repo convention) with a structured prompt →
     `{ outcome, topics[], objections[], commitments[], next_step, sentiment }`. Store JSON in
     `metadata.ai_summary`, one-liner in a `summary` display field.
   - **Gate:** only for `outcome='answered' AND duration_seconds > 30`. Voicemails/missed have no content —
     their metadata (Tier 1) is the whole signal. This keeps you from transcribing thousands of 8-sec VMs.
   - **Lazy + backpressured:** run as a separate cron over `voice_calls where metadata->>source='ghl' and
     transcript is null and outcome='answered' and duration_seconds>30`, N per tick. Never inline in the
     history backfill (rate limits + cost).
3. **Nothing** → Tier 1 metadata only.

Suggested summary prompt (system): *"You are summarizing a past sales/intake call for a dental-implant CRM.
Output strict JSON. Be factual, no invention. Fields: outcome, topics, objections, commitments, next_step,
sentiment."*

---

## UI — the pre-call context view

The caller needs ONE merged timeline. Two cases:

- If GHL calls go into **`voice_calls`** (recommended): the existing conversation thread / `CallCard` that
  already renders `voice_calls` will surface them automatically — **verify the thread's call query isn't
  filtered to `retell_call_id is not null`** (it must include `metadata->>source='ghl'`).
- Otherwise the view must explicitly **merge `messages` + `lead_activities(call_logged)` by timestamp** —
  calls live in a different table, so a texts-only thread would silently hide them.

Add a compact **"Last touch"** header on the dialer card: last inbound/outbound, channel, and — if the last
call has a summary — its one-liner, so the rep reads context before the dial connects.

---

## Sequencing

1. Land the base conversation backfill (other session) — messages flowing.
2. **Step 0** payload probe → lock call field mapping.
3. **Tier 1** normalizer + `voice_calls` persist → run/re-run backfill; calls now rich.
4. UI merge verify (calls visible in timeline + dialer card).
5. **Tier 2** summary cron over answered/long calls.
6. Gate calls on: consented + callable `stage_id` + GHL history present (`voice_calls`/`messages` exist).

## Verification queries

```sql
-- calls imported, by outcome
select outcome, count(*), round(avg(duration_seconds)) avg_sec
from voice_calls where organization_id=$org and metadata->>'source'='ghl' group by outcome;
-- summary coverage on answered calls
select count(*) filter (where metadata ? 'ai_summary') summarized,
       count(*) total
from voice_calls where organization_id=$org and metadata->>'source'='ghl'
  and outcome='answered' and duration_seconds>30;
-- a lead's full merged timeline (sanity spot-check)
select 'msg' k, created_at, channel, direction, left(body,60) detail
  from messages where lead_id=$lead
union all
select 'call', created_at, 'call', direction,
       outcome||' '||coalesce(duration_seconds::text,'?')||'s'
  from voice_calls where lead_id=$lead
order by created_at;
```
