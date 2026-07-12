# Enrichment Attribute Inventory (Workstream B2)

Every enrichment provider persists its **full** payload into
`lead_enrichment.enrichment_attributes` (jsonb, GIN-indexed) as namespaced
scalar keys, alongside the typed `data` payload it always stored. Namespaces:
`email.*`, `phone.*`, `geo.*`, `ads.*`, `web.*`, `experian.*`.

**Usage tags**

- `marketing` — audience selection, personalization, lead prioritization ONLY.
  **FCRA: must never feed credit/financing eligibility logic.** Enforced by
  `__tests__/fcra-guardrail.test.ts`.
- `operational` — identity/deliverability/routing signals; safe for scoring
  and workflow automation.

**Honesty notes**

- Keys marked with a provider requirement are only populated when that key is
  configured (`ZEROBOUNCE_API_KEY`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN`, MaxMind
  creds, per-org Google Ads credentials, `EXPERIAN_CLIENT_ID/...`). Without
  the key, email/phone persist a small operational stub
  (e.g. `email.sub_status = api_key_not_configured`) and Experian writes
  nothing at all.
- `experian.*` is open-ended: the raw ConsumerView vars payload is persisted
  verbatim (snake_cased, nulls skipped), so the exact key set depends on the
  variable groups purchased on the Experian contract. The counts below are the
  typical yield of the groups we request (`INCOME, CREDIT, PROPERTY,
  DEMOGRAPHICS, LIFESTYLE, FINANCIAL, MOSAIC`).
- Categories 8–9 are **not** stored in `enrichment_attributes`; they are typed
  `leads` columns written by other pipelines (conversation sweep, CareStack
  sync, messaging counters). They are inventoried here because they are part
  of the ~200-attribute surface the scoring/segmentation layers can draw on.

## Category accounting (~202 total)

| # | Category | Count | Source | Usage |
|---|----------|-------|--------|-------|
| 1 | Contact validation | 15 | ZeroBounce + Twilio Lookup | operational |
| 2 | Geo / IP | 12 | MaxMind | operational |
| 3 | Ad attribution | 15 | Google Ads API + lead UTM/attribution columns | operational |
| 4 | Website behavior | 10 | client JS (`custom_fields`) | operational |
| 5 | Experian demographics | ~40 | Experian ConsumerView (DEMOGRAPHICS + part of LIFESTYLE) | **marketing** |
| 6 | Wealth / property | ~25 | Experian ConsumerView (INCOME, PROPERTY, FINANCIAL) + typed lead columns | **marketing** |
| 7 | Behavioral segments | ~40 | Experian ConsumerView (MOSAIC + LIFESTYLE propensities) | **marketing** |
| 8 | Conversation-derived | ~20 | leads.conversation_* + financial_signals (AI sweep) | operational |
| 9 | Clinical / engagement | ~25 | leads dental_*, carestack_*, message counters | operational |

15 + 12 + 15 + 10 + 40 + 25 + 40 + 20 + 25 ≈ **202**

## 1. Contact validation (15) — operational

| Key | Source |
|-----|--------|
| `email.status`, `email.sub_status`, `email.free_email`, `email.disposable`, `email.did_you_mean`, `email.domain`, `email.domain_age_days`, `email.smtp_provider`, `email.mx_found` | ZeroBounce (`ZEROBOUNCE_API_KEY`) |
| `phone.valid`, `phone.line_type`, `phone.carrier`, `phone.caller_name`, `phone.country_code`, `phone.national_format` | Twilio Lookup (`TWILIO_*`) |

## 2. Geo / IP (12) — operational

`geo.ip`, `geo.city`, `geo.region`, `geo.country`, `geo.postal_code`,
`geo.latitude`, `geo.longitude`, `geo.timezone`, `geo.isp`, `geo.is_proxy`,
`geo.is_vpn`, `geo.distance_to_practice_miles` — MaxMind; requires
`leads.ip_address` captured on the lead.

## 3. Ad attribution (15) — operational

- `ads.campaign_name`, `ads.ad_group_name`, `ads.keyword`, `ads.match_type`,
  `ads.device` — gclid resolution (per-org Google Ads credentials; currently
  UTM-derived stub until the OAuth flow lands).
- Typed lead columns (written at capture, not by this pipeline):
  `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`,
  `gclid`, `fbclid`, `landing_page_url`, `referrer_url`, plus
  `campaign_attribution` jsonb (channel, campaign/ad-group ids+names,
  keyword_text, click_id_type, attribution model + confidence).

## 4. Website behavior (10) — operational

`web.pages_visited` (JSON array string), `web.time_on_site_seconds`,
`web.pricing_page_viewed`, `web.financing_page_viewed`,
`web.testimonials_viewed`, `web.before_after_viewed`, `web.device_type`,
`web.browser`, `web.session_count`, `web.form_time_seconds` — parsed from
client-JS payload in `leads.custom_fields`; populated only when the tracking
snippet ran on the landing page.

## 5. Experian demographics (~40) — marketing, requires `EXPERIAN_CLIENT_ID`

Representative keys (raw vars persisted verbatim, snake_cased):
`experian.exact_age`, `experian.estimated_age`, `experian.marital_status`,
`experian.household_size`, `experian.number_of_persons`,
`experian.children_present`, `experian.number_of_children`,
`experian.education_code`, `experian.education_level`,
`experian.occupation_code`, `experian.occupation`,
`experian.gender_household`, `experian.generations_in_household`,
`experian.presence_of_adults`, `experian.language_preference`,
`experian.dwelling_type`, `experian.length_of_residence`,
`experian.match_level`, `experian.data_date`, … (DEMOGRAPHICS group typically
returns ~40 scalar codes per matched consumer).

## 6. Wealth / property (~25) — marketing, requires `EXPERIAN_CLIENT_ID`

- Raw: `experian.household_income_code` / `experian.estimated_income`,
  `experian.home_owner`, `experian.home_value_code`,
  `experian.mortgage_indicator`, `experian.home_equity_indicator`,
  `experian.fss_code` (Financial Strategy Segment),
  `experian.bankcard_holder`, `experian.investment_active`,
  `experian.net_worth_code`, … (INCOME + PROPERTY + FINANCIAL groups,
  typically ~20 codes).
- Typed `leads` columns updated by the pipeline (marketing-data, commented as
  such in migration `20260711210000_enrichment_attributes.sql`):
  `household_income_band`, `homeowner_status`, `home_value_band`,
  `mosaic_segment`, plus the pre-existing structured bands inside the
  `experian_consumer` row's `data` payload (income range, home value range,
  credit tier band, financial segment).

## 7. Behavioral segments (~40) — marketing, requires `EXPERIAN_CLIENT_ID`

`experian.mosaic_group`, `experian.mosaic_type` (household lifestyle
segments), plus the LIFESTYLE propensity flags: `experian.mail_order_buyer`,
`experian.online_purchaser`, `experian.mail_responder`,
`experian.credit_card_user`, `experian.donor_charitable`,
`experian.pets_in_household`, `experian.travel_propensity`,
`experian.fitness_interest`, `experian.cosmetics_interest`, … (LIFESTYLE +
MOSAIC groups typically return ~40 propensity/interest codes; whatever the
contract returns is stored verbatim).

## 8. Conversation-derived (~20) — operational (typed `leads` columns)

`conversation_intent`, `conversation_sentiment`, `primary_objection`,
`conversation_red_flag`, `conversation_analyzed_at`, `conversation_summary`,
`financial_qualification_tier`, `financial_qualification_status`, plus
`financial_signals` jsonb (~10 extracted signals: insurance mentions,
financing interest level, savings/HSA-FSA mentions, monthly budget, down
payment, urgency, barriers), `ai_score`, `ai_qualification`, `ai_summary`.
Written by the conversation-analysis cron and financial-qualifier — the
financial-qualifier reads CONVERSATION text only, never Experian data
(see fcra-guardrail test).

## 9. Clinical / engagement (~25) — operational (typed `leads` columns)

- Clinical: `dental_condition`, `dental_condition_details`,
  `current_dental_situation`, `has_dentures`, `has_dental_insurance`,
  `insurance_provider`, `medical_conditions`, `medications`, `smoker`.
- CareStack sync: `carestack_appointment_id`, `carestack_appointment_type`,
  `carestack_location_id`, `carestack_operatory_id`,
  `carestack_provider_id`, `carestack_sync_status`.
- Engagement counters: `total_messages_sent`, `total_messages_received`,
  `total_emails_sent`, `total_emails_opened`, `total_sms_sent`,
  `total_sms_received`, `last_contacted_at`, `last_responded_at`,
  `response_time_avg_minutes`, `engagement_score`.

## Budgets

Per-provider monthly row budgets (per org, calendar month) guard the paid
APIs — see `budgets.ts` and `/api/cron/enrich`. Env overrides:
`ENRICH_BUDGET_EMAIL` (5000), `ENRICH_BUDGET_PHONE` (5000),
`ENRICH_BUDGET_GEO` (10000), `ENRICH_BUDGET_ADS` (10000),
`ENRICH_BUDGET_WEB` (50000), `ENRICH_BUDGET_PREQUAL` (2000),
`ENRICH_BUDGET_EXPERIAN` (2000).
