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

## Re-billing markup (platform default) — **4× cost**

House policy is a flat **4× re-bill**: the practice pays 4× what we pay the provider, across every
service. In the markup field that is a **300% markup** (`billable = cost × (1 + 300/100) = cost × 4`).

| Service | Default markup | Multiple |
|---|---:|---:|
| AI | **300%** | 4× |
| SMS | **300%** | 4× |
| Voice | **300%** | 4× |
| Email | **300%** | 4× |

> **Vocabulary.** "400% upcharge" in plain speech = charge 4× cost = a **300% markup on top of cost**.
> The `billing_settings.markups` field and `DEFAULT_MARKUP_PCT` store markup-over-cost (300), not the
> multiple (4). Keep the two straight.

Overridable per practice in `billing_settings.markups` (jsonb) — e.g. dial voice toward a telephony
pass-through. Empty → the 300% platform default. Fractional cents are preserved and rounded **only**
at display aggregation, so thousands of sub-cent AI calls sum accurately.

### Blended economics per engaged lead (illustrative)

A lead that receives a handful of AI touches, ~4 SMS segments, and one 3-minute call:

| Bucket | Cost | Billable (w/ markup) |
|---|---:|---:|
| AI (~7–8 calls) | ~$0.076 | ~$0.114 |
| SMS (4 segments) | ~$0.032 | ~$0.045 |
| Voice (1 × 3 min) | ~$0.24 | ~$0.31 |
| **Total / lead** | **~$0.35** | **~$0.47** → ~$0.12 margin |

_Numbers are illustrative; the dashboard shows real figures per practice over 7/30/90 days._

## Real state & the live-compute panels (2026-07-04)

**The ledger is nearly empty, so the panels compute live.** A prod audit found `cost_events` with
**zero rows** and `ai_usage` with 12 rows / $0.21 over 90 days — SMS/voice cost capture isn't
flowing (most sends predate the feature or bypass `sendSMSToLead`; AI token capture on `messages`
is 0). Reading spend off those tables shows ≈ $0 despite real volume. So both cost panels now
compute cost/billable **live from the source tables** via the `usage_rollup` RPC
(`messages` + `voice_calls` + `ai_usage`), pricing in TS with this rate card + markup:

- **Agency super-admin** — `/agency/spend` (Spend & Margin): provider cost, billable, margin, and the
  effective re-bill multiple **per practice**, plus a policy strip showing the 4× default.
- **Per-account (customer)** — `/settings/usage` (Usage & Costs): the practice's own AI + SMS + phone
  volume with **upcharge included** (billable only — never our cost or margin). Gated on `billing:read`.

Both read through `loadLiveSpend()` in [src/lib/billing/usage-live.ts](../src/lib/billing/usage-live.ts).

**What the real numbers say (platform-wide, effectively one active practice — SF Dentistry):**

| Service | Volume (all-time) | Our cost | Note |
|---|---|---:|---|
| SMS out | 25,797 msgs · ~67,723 segments | ~$745 | the entire cost base |
| SMS in | 5,282 msgs | ~$42 | Twilio bills inbound too |
| Voice | 13 calls · ~33 min | ~$3 | negligible today |
| Email | 638 sends | <$1 | flat plan |
| AI | not captured | est. low $10s/mo | token capture not wired |

Marginal (usage) cost runs **≈ $100/month**, ~100% of it Twilio SMS. At the 4× policy that bills
≈ $400/mo (≈ $300/mo margin) for this practice. **Takeaway:** usage markup is competitively fine
(4× ≈ 5.5¢/segment to the client) but a small absolute line until SMS volume grows 10–100×. The real
lever is the flat `billing_settings.platform_fee_cents` (currently 0, unused). Follow-up to make the
ledger invoice-grade: backfill `cost_events` from history + fix the SMS/AI capture path.

## Activating this

The live panels need no env work — they compute from tables that already exist:

1. Apply `supabase/migrations/20260704180000_usage_rollup.sql` (the `usage_rollup` RPC that feeds both
   panels). **Applied to prod 2026-07-04.**
2. Base tables + RLS from `20260701120000_spend_tracking.sql` are already applied.
3. (Optional) Set per-practice markups in `billing_settings.markups`; otherwise the 4× default applies.
4. View at **Agency → Spend & Margin** (super-admin) and **Settings → Usage** (per practice).

_Follow-up (for invoice-grade accuracy, not needed for the panels):_ backfill `cost_events` from
history and fix ongoing SMS/AI ledger capture, then set `CRON_SECRET` + Twilio env so `reconcile-costs`
finalizes SMS to Twilio's billed price.
