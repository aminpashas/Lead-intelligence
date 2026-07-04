# Operations KPIs → App (implementation plan)

Digitizes the monthly `Operations_KPIs_July_2026.xlsx` (3 sheets) into the CRM.
Owner request 2026-07-04: **"In Closing" is the priority — the hottest workflow to follow.**

## Source spreadsheet → app mapping

| Sheet | Surface | Data source | Phase |
|---|---|---|---|
| **Case Follow ups** | `/closing` — In-Closing deals board | leads in `treatment-presented` + `financing` stages | **1 (priority)** |
| **Office Daily KPI** | `/analytics/daily` — Daily KPI dashboard | contracts ($), appointments (consult/no-show), lead_activities (calls), leads | 2 |
| **Pipeline** | Monthly funnel-rate panel (in Daily KPI page or /analytics) | stage-conversion RPC per service line | 3 |

Column mapping for Case Follow ups:
- Name/Last Name → `leads.first_name/last_name`
- Service → `classifyLeadServiceLines(lead)` (`src/lib/leads/service-line.ts`)
- Date of last Contact → `leads.last_contacted_at`
- Cost → `leads.treatment_value`
- Status ("Down Payment Pending", "maybe", "cold") → editable `leads.closing_temperature` (derived default, manual override)
- Strategy / Notes ("offered 3rd party financing") → editable `leads.closing_next_step`

## "In Closing" definition
Stages `treatment-presented` + `financing` (owner decision). Same population as the
"Stalled Deals" nurture cohort — the board is the human front door to the deals the
AI nurtures in the background.

## Phase 1 files
- `supabase/migrations/<ts>_closing_workflow.sql` — `closing_temperature`, `closing_next_step`, `closing_updated_at` on `leads` (apply via `supabase db query --linked -f`)
- `src/lib/pipeline/closing.ts` — `CLOSING_STAGE_SLUGS`, `deriveClosingTemperature()`, `closingForecast()`
- `src/app/(dashboard)/closing/page.tsx` — server page
- `src/components/crm/closing-board.tsx` — client board
- `src/app/api/leads/[id]/closing/route.ts` — PATCH editable fields
- `src/components/dashboard/sidebar.tsx` + `src/lib/auth/permissions.ts` (`/closing` → `pipeline:read`)

## Reuse (already in repo)
- `scoreCloseProbability` / `computeCloseBaseRate` — `src/lib/pipeline/close-probability.ts`
- `LeadActions` — `src/components/crm/lead-actions.tsx`
- `decryptLeadsPII` — `src/lib/encryption`
- `resolveActiveOrg` / `getOwnProfile` — `src/lib/auth/active-org`

## Status
- [ ] Phase 1 — In-Closing board
- [ ] Phase 2 — Daily KPI dashboard (⚠️ production/collection $ source: confirm contracts vs payments population)
- [ ] Phase 3 — Monthly funnel rates
