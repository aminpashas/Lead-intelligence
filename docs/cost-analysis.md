# Cost Analysis — Anthropic + Twilio + Retell

_Reference for the Spend & Margin dashboard (`/agency/spend`). All rates are for in-app
tracking; the provider invoices remain the source of record. Rates last verified 2026-07-01._

## How each cost is captured

| Service | What we pay | Capture pattern | Where |
|---|---|---|---|
| **AI** (Anthropic) | Computed from the `usage` token counts on every Claude response × the per-model rate. Anthropic never pushes a per-request dollar figure. | **Exact at write** | `ai_usage` via `recordAiUsage()` ([src/lib/ai/usage.ts](../src/lib/ai/usage.ts)) |
| **SMS** (Twilio) | Segments known at send; Twilio's real `price` lands async. | **Estimate at send → reconcile to actual** | `cost_events` (est. in `sendSMSToLead`, finalized by the `reconcile-costs` cron) |
| **Voice** (Retell) | Nothing known until the call ends; Retell reports `call_cost.combined_cost`. | **Capture final once** at `call_ended` | `cost_events` (Retell webhook `/api/voice/events`) |

The `cost_events` ledger stores both `cost_cents` (what we pay) and `billable_cents` (what we
re-bill the practice = cost × (1 + markup)), with the markup **snapshotted at event time** so a
later markup change never retroactively re-prices history.

## Anthropic rate card (per 1M tokens)

| Model | Input | Output | Notes |
|---|---:|---:|---|
| `claude-haiku-4-5` | $1.00 | $5.00 | conversation summaries, cheap classification |
| `claude-sonnet-4-6` | $3.00 | $15.00 | primary model (scoring, agents, drafting) |
| `claude-opus-4-8` / `4-7` / `4-6` | $5.00 | $25.00 | — |
| `claude-sonnet-5` | $3.00 | $15.00 | intro $2/$10 through 2026-08-31 |

**Cache tokens** are priced off the input rate: cache **read** ≈ 0.1×, cache **write** ≈ 1.25×.
Captured in `ai_usage.cache_read_tokens` / `cache_write_tokens`.

> **Two bugs this work fixed.** The old table priced Opus 4.5/4.7 at **$15/$75** (stale Opus-3-era
> pricing) — a ~3× overcount. And any model not in the table silently cost **$0**, so spend on a
> newly-added model vanished with no error. Both are corrected in
> [src/lib/billing/pricing.ts](../src/lib/billing/pricing.ts): Opus 4.5–4.8 are $5/$25, and an
> unmapped model books a conservative non-zero cost flagged with `metadata.unknown_model`.

### Representative AI cost per call (illustrative)

| Feature | Model | ~Tokens (in/out) | Cost / call |
|---|---|---|---:|
| Conversation summary | Haiku 4.5 | 2,000 / 300 | ~$0.0035 |
| Lead score / personalize | Sonnet 4.6 | 1,500 / 500 | ~$0.012 |
| Setter/closer agent turn (multi-round) | Sonnet 4.6 | 8,000 / 1,500 | ~$0.047 |

## Twilio SMS

- **Estimate:** ~1.1¢ / outbound segment (US A2P 10DLC ≈ $0.0079 carrier + ~$0.003 A2P surcharge).
- **Actual:** reconciled to Twilio's billed `price` (magnitude of the negative price string) with the
  real `num_segments`.
- Editable fallback: `SMS_ESTIMATE_CENTS_PER_SEGMENT` in `pricing.ts`.

## Retell Voice

- **Estimate fallback:** ~8¢ / minute (engine + telephony), `VOICE_ESTIMATE_CENTS_PER_MINUTE`.
- **Actual:** `call_cost.combined_cost` (cents) from Retell at call end — this is the recorded value;
  no estimate is used because duration isn't known until the call completes.

## Re-billing markup (platform defaults)

| Service | Default markup | Rationale |
|---|---:|---|
| AI | **50%** | raw provider cost is a fraction of a cent; highest value-add |
| SMS | **40%** | — |
| Voice | **30%** | closer to a telephony pass-through |
| Email | **40%** | — |

Overridable per practice in `billing_settings.markups` (jsonb). Empty → platform defaults.
Fractional cents are preserved through the ledger and rounded **only** at invoice/display
aggregation, so thousands of sub-cent AI calls sum accurately.

### Blended economics per engaged lead (illustrative)

A lead that receives a handful of AI touches, ~4 SMS segments, and one 3-minute call:

| Bucket | Cost | Billable (w/ markup) |
|---|---:|---:|
| AI (~7–8 calls) | ~$0.076 | ~$0.114 |
| SMS (4 segments) | ~$0.032 | ~$0.045 |
| Voice (1 × 3 min) | ~$0.24 | ~$0.31 |
| **Total / lead** | **~$0.35** | **~$0.47** → ~$0.12 margin |

_Numbers are illustrative; the dashboard shows real figures per practice over 7/30/90 days._

## Activating this

1. Apply migration `supabase/migrations/20260701120000_spend_tracking.sql` (creates `cost_events`,
   `billing_settings`, extends `ai_usage`, and widens RLS so **agency admins see all practices'**
   usage — without it the dashboard renders zeros).
2. Set the `CRON_SECRET` and Twilio env vars so `reconcile-costs` (every 30 min) can finalize SMS.
3. (Optional) Set per-practice markups; otherwise platform defaults apply.
4. View at **Agency → Spend & Margin**.
