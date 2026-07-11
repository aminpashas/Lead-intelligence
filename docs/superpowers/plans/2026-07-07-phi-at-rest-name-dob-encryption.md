# PHI-at-rest: encrypt patient names + DOB + clinical free-text

**Status:** PLAN ONLY — not implemented. This is the PHI audit's C1/C2, the
single finding a HIPAA diligence team leads with. It is deliberately staged as
its own effort because it touches every lead read path in the app and a botched
rollout renders patient names as `enc::…` gibberish everywhere.

## Problem
`supabase/migrations/002_leads_and_pipeline.sql` stores `first_name`, `last_name`
(plaintext), `date_of_birth` (a `date` column — cannot hold `enc::`), and clinical
free-text (`medical_conditions[]`, `medications[]`, `dental_condition_details`,
`current_dental_situation`, `notes`) all in the clear. `PII_FIELDS`
(`src/lib/encryption.ts:129`) deliberately omits names; DOB is listed but silently
no-ops because the column type can't hold ciphertext. A DB dump / read-replica /
service-key leak yields fully-identified patients + health data with zero crypto.

## Why it's high-risk
`encryptLeadPII`/`decryptLeadPII` are centralized and driven by `PII_FIELDS`, so
adding names *auto-encrypts on write and auto-decrypts on read* — BUT only for
paths that call `decryptLeadPII`. Names were never encrypted, so many read paths
render `lead.first_name` raw and never learned to decrypt. Encrypt + backfill
without auditing all of those → `enc::` shown app-wide. (Memory: 7 pages were
already caught doing this for email/phone; names have far more raw-render sites.)

## Staged rollout (each step independently deployable)

1. **Schema (migration).**
   - `alter table leads add column first_name_hash text, add column last_name_hash text;`
   - `alter table leads add column date_of_birth_enc text;` (keep the old `date`
     column temporarily; new writes populate `_enc`).
   - Encrypt clinical free-text in place (they're already `text`/`text[]` → store
     `enc::` string; arrays become an encrypted JSON string).
   - Add `CHECK (first_name LIKE 'enc::%')` etc. ONLY at the end (step 5).

2. **Write path.** Add `first_name`, `last_name`, `date_of_birth`,
   `medical_conditions`, `medications`, `dental_condition_details`,
   `current_dental_situation`, `notes` to `PII_FIELDS`; extend `encryptLeadPII` to
   also compute `first_name_hash`/`last_name_hash` via `searchHash`. Ship. Now new
   writes are encrypted; reads still work because `decryptLeadPII` handles them.

3. **Audit read paths.** Grep every `\.first_name`, `\.last_name`, `.date_of_birth`
   render/select that does NOT route through `decryptLeadPII`/`decryptLeadsPII`.
   Known families: leads table, lead card, pipeline board, conversation thread
   header, dashboards, exports, Slack/webhook connectors, AI context builders,
   voice/SMS templates. Fix each to decrypt. THIS IS THE BULK OF THE WORK — budget
   for it. Add an ESLint rule flagging raw `lead.first_name` interpolation.

4. **Name search → hashes.** Anywhere name search uses `ilike '%name%'` must switch
   to `first_name_hash = searchHash(term)` (exact) — substring name search on
   encrypted data is not possible; product-decide whether to keep a normalized
   prefix or drop substring name search.

5. **Backfill + enforce.** Resumable script over ~48k leads: for each row still
   plaintext, encrypt names/DOB/clinical + compute hashes (mirror
   `src/scripts/backfill-pii-encryption.ts`). Then drop the old `date_of_birth`
   `date` column, rename `_enc`, and add the `CHECK (… LIKE 'enc::%')` constraints
   (extend `20260604_enforce_leads_pii_encrypted.sql`).

6. **Flip `decryptField` to reject plaintext in prod** (env flag) once backfill is
   confirmed 100%, so a future forgotten-encrypt write fails loudly instead of
   silently storing cleartext (PHI audit M3).

## Related already-shipped this session
- Audit-log name redaction: DONE (migration 20260707120300 applied to prod) — so
  the audit trail stops writing NEW cleartext names even before step 1.
- Public finance page: DONE — last name no longer rendered on the pre-auth page.
- Note: historical `audit_events` rows still contain cleartext names (append-only
  WORM log). Scrubbing them is a separate, sensitive decision.
