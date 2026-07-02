# SMS Training Console — Design

**Date:** 2026-07-01
**Status:** Approved design, pending spec review → implementation plan
**Branch context:** builds on `feat/phone-first-booking` (current) / to be branched fresh

## 1. Problem & motivation

The operator wants to train the AI **over SMS** from a trusted phone (`+14156767420`).
Texting a reserved command should flip that thread into a training console where the
operator can (a) role-play against the AI and (b) correct the AI, with corrections
persisted as durable rules that immediately govern live patient conversations.

Two facts from the codebase shape the design:

1. **The trigger pattern already exists.** `src/app/api/webhooks/twilio/route.ts`
   already intercepts `STOP` / `START` / `YES` as reserved keywords *before* the AI
   autopilot runs (lines 78–156). A training command is one more intercept in that
   chain.

2. **Training only "sticks" through `ai_memories` / `ai_knowledge_articles`.** Live
   setter/closer agents ingest org guidance via `buildLiveAgentKnowledgeBlock`
   (`src/lib/ai/training-context.ts:150`), called at `setter-agent.ts:332` and
   `closer-agent.ts:569`. The `ai_training_examples` table is **write-only** — the
   roleplay "extract" route (`src/app/api/ai/training/roleplay/[id]/extract/route.ts:42`)
   inserts into it, and **nothing reads it back**. So a correction must become a
   *rule the live agents actually read*, not an inert training example.

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Modes | **Two**, chosen by command word: roleplay (AI = patient) + dry-run (AI = coordinator) |
| Enter/exit | **Explicit command words** — deterministic, zero false positives |
| Scope of learning | **Agency-wide** (applies to every practice), not per-practice |
| Persistence | **Durable rule** shape (title/content/category/priority/on-off) |
| Dry-run fidelity | **Ephemeral in-memory context** (no DB sandbox lead) |
| Access control | **Number allowlist + PIN** to open a session |
| Command set | **Full** (`ROLEPLAY`, `TRAIN`, `FIX`, `RULE`, `SAVE`, `DONE`/`EXIT`, `HELP`, `STATUS`) |

### Composition note: "agency-wide" + "ai_memory"

`ai_memories` is **org-scoped** (`organization_id`), so a saved rule cannot literally be
an `ai_memory`. Resolution: a new **agency-scoped** rules store (`agency_ai_rules`, no
`organization_id`) with the same *shape* as a memory, injected into every practice's
live agents via a new `buildAgencyRulesBlock`. This honors both the "rule" shape and the
"agency-wide" scope.

## 3. Command grammar

From an allowlisted trainer number, the **first token** (case-insensitive) routes the
message. Mirrors the existing STOP/START/YES interceptor style.

| Command | Effect |
|---|---|
| `TRAIN <pin>` | Open **dry-run** mode. You text as a patient; the live agent replies as it really would; you critique. PIN required to open. |
| `ROLEPLAY <pin> [scenario]` | Open **roleplay** mode. AI plays the *patient*; you practice as coordinator. `scenario` fuzzy-matches the 7 `BUILT_IN_SCENARIOS`; omitted → `new-patient-sms`. AI sends the opening patient text. |
| `FIX <guidance>` | (dry-run only) Regenerate the AI's **last** reply using your steer. Reuses `generateRolePlayRetry`. Repeatable. |
| `SAVE` | (dry-run only) Promote the AI's last reply into an agency rule verbatim. |
| `RULE <text>` | Save a durable agency rule. Live in every practice on the next message. Valid **in or out** of a session (still PIN-gated when no session is open — see §7). |
| `DONE` / `EXIT` | End the session; reply with a coached summary (`generateSessionSummary`). |
| `HELP` | List commands. |
| `STATUS` | Show current mode + scenario + rules-saved-this-session. |

**Reserved-word collisions:** exit is `DONE`/`EXIT`, never `STOP` (STOP stays the TCPA
opt-out). `TRAIN`/`ROLEPLAY`/`RULE` are not existing keywords.

## 4. SMS state machine

```
inbound SMS (Twilio webhook, signature already validated)
   │
   ├─ normalize From → E.164; is it in the trainer allowlist?
   │        └─ no ─▶ existing lead pipeline, UNCHANGED
   │
   yes ── training module OWNS the message (returns handled TwiML;
   │       never reaches the lead lookup — this also fixes the
   │       "webhook drops non-lead senders" gap for this number)
   │
   ├─ load active session for this trainer_phone (status='active', not idle-expired)
   │
   ├─ no active session:
   │     • TRAIN <pin> / ROLEPLAY <pin> … → verify PIN → open session
   │     • RULE <pin?> <text>             → verify PIN → save rule (no session)
   │     • HELP / STATUS                  → info
   │     • anything else                  → short HELP hint
   │
   └─ active session:
         • DONE / EXIT      → summarize + close
         • STATUS / HELP    → info
         • RULE <text>      → save agency rule, ack
         • FIX <guidance>   → (dry-run) regenerate last AI reply
         • SAVE             → (dry-run) promote last AI reply to a rule
         • any other text   → a CONVERSATION TURN:
               roleplay  → generateRolePlayResponse (AI = patient)
               dry-run   → routeToAgent on ephemeral context (AI = coordinator)
             → append to transcript, text reply back to trainer tagged "🤖"
```

Consequence (intended): the trainer number can't double as a normal test-lead — training
always wins on it.

## 5. Modes → existing engines

- **ROLEPLAY (AI = patient):** `generateRolePlayResponse(supabase, refOrgId, session)` with
  `user_role='treatment_coordinator'`. No new AI logic — the roleplay simulator over SMS.
  Scenario/persona come from the chosen `BUILT_IN_SCENARIOS` entry.

- **DRY-RUN (AI = coordinator):** build an **ephemeral** `AgentContext` from the session
  transcript (history) with a synthetic `lead`/`conversation` — no DB row — then call
  `routeToAgent(supabase, ctx)` to get the live agent's draft, and text that draft back to
  the trainer **instead of sending it to anyone**. `patient_profile` / `financing` /
  `handoff` context is empty (acceptable for critiquing phrasing/behavior). We bypass
  `sendAgentResponse` entirely, so no consent/TCPA gate is involved.

- **Reference org:** `routeToAgent` and `buildLiveAgentKnowledgeBlock` need *an*
  `organization_id`. Training is agency-wide, so dry-run **generates against a configurable
  reference practice** (`agency_settings.training_reference_org`, fallback = first practice
  org). Only *generation* borrows an org; the *saved rules* remain agency-wide.

## 6. Data model (one migration)

### `agency_ai_rules` — the store that makes training stick
```sql
create table agency_ai_rules (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  content      text not null,
  category     text not null default 'general',
  priority     int  not null default 100,   -- higher = injected earlier
  is_enabled   boolean not null default true,
  source       text not null default 'sms_training',
  created_by   text,                          -- trainer phone (E.164)
  created_at   timestamptz not null default now()
);
-- NO organization_id — agency-wide by design.
-- RLS: readable by service role (agents) + agency_admin; writable by agency_admin/service.
```

### `sms_training_sessions` — state between stateless webhooks
```sql
create table sms_training_sessions (
  id                uuid primary key default gen_random_uuid(),
  trainer_phone     text not null,            -- E.164, plain (operator infra, not patient PHI)
  mode              text not null,            -- 'roleplay' | 'dry_run'
  scenario_key      text,
  patient_persona   jsonb,
  reference_org_id  uuid,
  transcript        jsonb not null default '[]',  -- [{role, content, ts}]
  rules_saved       int not null default 0,
  status            text not null default 'active', -- 'active' | 'ended'
  started_at        timestamptz not null default now(),
  last_activity_at  timestamptz not null default now(),
  ended_at          timestamptz
);
create unique index one_active_session_per_phone
  on sms_training_sessions (trainer_phone) where status = 'active';
```

Idle expiry is **lazy**: on each inbound, an `active` session older than `IDLE_TTL`
(default 6h) is treated as ended before routing (no new cron).

### Injection
New `buildAgencyRulesBlock(supabase): Promise<string>` selects `is_enabled` rules ordered
by `priority desc`, formats them exactly like the memory formatter
(`### {title} [{category}]\n{content}`), returns `''` when empty. Added to the existing
`Promise.all([...])` blocks in **`setter-agent.ts:332`** and **`closer-agent.ts:569`** and
concatenated into the system prompt beside `buildLiveAgentKnowledgeBlock` +
`buildAgencyPersonaBlock`.

### Rule content derivation
SMS gives only free text. Derive synchronously: `title` = first ~8 words (truncated),
`category` = `'general'`, `content` = full text, `priority` = 100. (Optional later
enhancement: a lightweight AI titling/categorization call — out of core scope to keep SMS
latency low.)

## 7. Security

- **Webhook authenticity:** already enforced — `validateTwilioWebhook` rejects unsigned/
  forged requests (`route.ts:21–30`). Unchanged.
- **Allowlist:** `agency_settings.sms_trainer_numbers` = JSON array of E.164 numbers
  (env fallback `SMS_TRAINER_NUMBERS`). Inbound `From` is normalized to E.164 and matched.
- **PIN:** `agency_settings.training_pin`. Required to **open** a session (`TRAIN <pin>` /
  `ROLEPLAY <pin>`) and to run `RULE` **without** an open session. Once a session is open,
  subsequent turns/`RULE`/`FIX`/`SAVE` inherit the session's authenticated state (no PIN
  re-entry per message). Rationale: `From` alone is a weak credential for a channel that
  rewrites every practice's agent prompt; the PIN raises the bar cheaply.
- **Abuse bounds:** rule `content` length-capped; `RULE`/`SAVE` are trusted operator input
  (no `wrapUserContent` — rules are *meant* to be instructions), but capped in count/length
  to prevent unbounded prompt bloat. Existing webhook rate-limit still applies.

## 8. Error handling & edge cases

- Wrong/missing PIN on open → terse "invalid PIN" reply; no session created.
- `RULE` with empty text → usage hint.
- `ROLEPLAY <unknown scenario>` → fall back to default, note the fallback in the ack.
- `FIX` / `SAVE` outside dry-run, or with no prior AI message → helpful error.
- `SAVE` in roleplay mode → rejected (AI is the patient there; nothing to promote).
- Second `TRAIN`/`ROLEPLAY` while a session is active → `STATUS`-style "already in X;
  DONE to end" (the unique index guarantees one active session).
- All AI turns tagged (e.g. `🤖 `) so training replies never read as real activity.
- Every reply kept SMS-length.

## 9. Testing

Pure/near-pure units get TDD (same pattern as `src/lib/__tests__/live-agent-knowledge.test.ts`):
- Command **parser**: token routing, PIN extraction, scenario parsing, collisions (STOP vs DONE).
- **State transitions**: open → turn → fix → save → done; no-session vs session branches; idle expiry.
- **Allowlist + PIN** gate: match/normalize, reject wrong PIN.
- `buildAgencyRulesBlock`: ordering, empty case, formatting; and its **injection** into
  setter/closer prompts.

`tsc --noEmit` must pass before any push — type errors (test files included) fail the
Vercel build on main.

## 10. Files

**New**
- `src/lib/autopilot/sms-training.ts` — orchestrator, command parser, state machine.
- `src/lib/ai/agency-rules.ts` — `buildAgencyRulesBlock` + rule CRUD helpers
  (or extend `training-context.ts`).
- `supabase/migrations/<ts>_sms_training.sql` — the two tables + RLS.

**Modified**
- `src/app/api/webhooks/twilio/route.ts` — training intercept before the lead lookup.
- `src/lib/ai/setter-agent.ts`, `src/lib/ai/closer-agent.ts` — inject the rules block.
- `src/types/database.ts` — types for the two new tables.

## 11. Non-goals (YAGNI)

- No intent classifier (command words are explicit).
- No wiring of `ai_training_examples` into live prompts (rules cover the need; the dead
  table stays out of scope).
- No SMS menu UX beyond `HELP`/`STATUS`, no multi-staff roles/RBAC (single allowlist +
  PIN), no per-practice targeting.

**Open items for spec review**
- Confirm allowlist **+ PIN** (not allowlist-only) is the intended access model.
- Confirm the reference-org default (home org vs a named flagship practice).
