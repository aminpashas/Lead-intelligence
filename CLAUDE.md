@AGENTS.md

# Lead Intelligence — AI-Powered Implant CRM

## Tech Stack
- **Framework**: Next.js 16 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **Database**: Supabase (PostgreSQL) with RLS, multi-tenant via `organization_id`
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`) — scoring + engagement
- **SMS**: Twilio — two-way SMS with AI auto-response
- **Email**: Resend — transactional + campaign emails
- **State**: Zustand (client), Supabase Realtime (live updates)
- **Drag & Drop**: @dnd-kit (pipeline kanban)

## Project Structure
- `src/app/(auth)/` — Login/signup pages
- `src/app/(dashboard)/` — Authenticated CRM pages (pipeline, leads, conversations, etc.)
- `src/app/api/` — API routes (leads CRUD, webhooks, AI scoring, messaging)
- `src/components/crm/` — CRM-specific components (pipeline board, lead card, leads table, lead detail)
- `src/components/dashboard/` — Layout components (sidebar, topbar, shell)
- `src/lib/ai/` — AI scoring engine and engagement prompts
- `src/lib/messaging/` — Twilio SMS and Resend email clients
- `src/lib/supabase/` — Server/client/middleware Supabase clients
- `src/lib/validators/` — Zod schemas for API validation
- `src/lib/store/` — Zustand stores
- `src/types/` — TypeScript types (database.ts mirrors Supabase schema)
- `supabase/migrations/` — SQL migrations (001-004)

## Key Patterns
- Multi-tenant: Every table has `organization_id` + RLS via `get_user_org_id()`
- API routes use `createClient()` (auth context) or `createServiceClient()` (admin/webhooks)
- AI scoring: 6 dimensions weighted to 0-100 score → Hot/Warm/Cold/Unqualified
- Webhook: POST to `/api/webhooks/form?org=<org_id>` for lead capture
- Pipeline: Drag-and-drop kanban with optimistic updates

## Commands
- `npm run dev` — Start dev server
- `npm run build` — Production build
- Environment: Copy `.env.local.example` to `.env.local` and fill in API keys
