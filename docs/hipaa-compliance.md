# HIPAA Compliance Guide — Lead Intelligence CRM

## Overview

Lead Intelligence handles Protected Health Information (PHI) including patient names, contact information, dental conditions, insurance details, and treatment discussions. This document outlines the technical and administrative safeguards implemented to meet HIPAA requirements.

---

## 1. Business Associate Agreements (BAAs)

All third-party services that process, store, or transmit PHI **must** have a signed BAA.

| Vendor | Service | PHI Exposure | BAA Status | Notes |
|--------|---------|-------------|------------|-------|
| **Supabase** | Database + Auth | Full PHI at rest | **Required** | Supabase offers BAAs on Pro/Enterprise plans. Contact sales@supabase.io |
| **Twilio** | SMS messaging | Phone numbers + message content | **Required** | Twilio signs BAAs. Request via twilio.com/hipaa |
| **Resend** | Email delivery | Email addresses + message content | **Required** | Contact Resend support for BAA availability |
| **Anthropic** | AI (Claude API) | Scrubbed lead context (PHI minimized) | **Required** | Anthropic offers BAAs for enterprise. PHI scrubbing reduces exposure |
| **Vercel** | Hosting + Edge | API request data in transit | **Required** | Vercel offers BAAs on Enterprise plan |

### Action Items
- [ ] Obtain signed BAA from Supabase (upgrade to Pro if needed)
- [ ] Request and sign Twilio BAA via their HIPAA page
- [ ] Contact Resend for BAA (or evaluate HIPAA-compliant email alternatives)
- [ ] Request Anthropic BAA for Claude API usage
- [ ] Obtain Vercel Enterprise BAA or self-host

---

## 2. Technical Safeguards

### 2.1 Encryption

**At Rest (Application-Level)**
- PII fields encrypted with AES-256-GCM before database storage
- Fields encrypted: `email`, `phone`, `phone_formatted`, `date_of_birth`, `insurance_provider`, `insurance_details`
- Encryption key stored in `ENCRYPTION_KEY` environment variable (64-char hex)
- Each value gets a unique random IV (no deterministic encryption)
- Search hashes (HMAC-SHA256) stored alongside for lookup without decryption

**At Rest (Infrastructure)**
- Supabase PostgreSQL uses disk-level encryption (AES-256)
- Application-level encryption provides defense-in-depth (DB breach alone doesn't expose PII)

**In Transit**
- All API communication over HTTPS/TLS 1.2+
- Supabase connections use SSL
- Twilio and Resend APIs use TLS

### 2.2 Access Controls
- Row-Level Security (RLS) on all tables via `organization_id`
- Supabase auth with JWT tokens
- Service role key restricted to server-side only (webhooks, cron)
- No direct database access from client-side

### 2.3 Audit Logging
- `hipaa_audit_log` table records all PHI access events
- Event types: `phi_access`, `phi_stored`, `phi_deleted`, `phi_transmitted`, `ai_processing`, `ai_phi_scrubbed`
- Logged endpoints:
  - GET /api/leads (bulk PHI access)
  - GET /api/leads/[id] (individual PHI access)
  - POST /api/leads (PHI creation)
  - PATCH /api/leads/[id] (PHI updates)
  - DELETE /api/leads/[id] (PHI deletion)
  - GET /api/conversations/[id]/messages (message content access)
  - POST /api/sms/send (PHI transmission to Twilio)
  - POST /api/email/send (PHI transmission to Resend)
  - POST /api/webhooks/form (PHI ingestion)
  - All AI processing (scrubbing + compliance checks)

### 2.4 Data Minimization (AI Processing)
- `buildSafeLeadContext()` strips last name, email, phone, address before AI calls
- `scrubPHI()` detects and replaces 13 PHI categories with redaction placeholders
- `checkResponseCompliance()` validates AI outputs don't contain medical diagnoses, treatment guarantees, or PHI solicitation
- Full HIPAA system prompt instructs AI models to refuse PHI disclosure

### 2.5 Consent Tracking (TCPA/CAN-SPAM)
- SMS consent: `sms_consent`, `sms_consent_at`, `sms_consent_source` fields
- Email consent: `email_consent`, `email_consent_at`, `email_consent_source` fields
- STOP keyword handling for SMS opt-out (TCPA compliance)
- One-click unsubscribe for emails (CAN-SPAM / RFC 8058)
- Campaign enrollment checks consent before sending

---

## 3. AI Model Evaluation for HIPAA

### Current Implementation (Claude API)
- **Data sent to AI**: First name only, dental condition, urgency, financing interest, appointment history, scrubbed conversation excerpts
- **Data NOT sent**: Last name, email, phone, DOB, SSN, insurance IDs, full address
- **PHI detection**: 13 regex patterns covering all 18 Safe Harbor identifiers
- **Response compliance**: Checks for medical diagnoses, treatment guarantees, PHI solicitation
- **Prompt injection defense**: 15+ patterns detecting instruction override, role manipulation, data exfiltration

### Recommendations
- Anthropic BAA required before production use with any PHI
- Consider Anthropic's HIPAA-eligible endpoint if available
- Log all AI interactions to `ai_interactions` table with token counts (no full prompts stored)
- Periodically audit AI outputs for PHI leakage

---

## 4. Breach Response Plan

### 4.1 Detection
- Monitor `hipaa_audit_log` for `severity = 'critical'` or `severity = 'violation'` events
- Alert on unusual patterns: bulk PHI access, access outside business hours, failed auth attempts
- Prompt injection detection logs to audit trail

### 4.2 Response Timeline (per HIPAA Breach Notification Rule)
| Timeframe | Action |
|-----------|--------|
| **0-24 hours** | Contain the breach: revoke compromised credentials, rotate ENCRYPTION_KEY if needed |
| **0-48 hours** | Assess scope: query `hipaa_audit_log` for affected records and PHI categories |
| **0-60 days** | Notify affected individuals in writing |
| **0-60 days** | Notify HHS (if 500+ individuals: immediate; if fewer: annual log) |
| **0-60 days** | Notify media (if 500+ individuals in a single state) |

### 4.3 Key Rotation Procedure
1. Generate new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Set `ENCRYPTION_KEY_OLD` to current key
3. Set `ENCRYPTION_KEY` to new key
4. Run re-encryption migration script (decrypt with old, encrypt with new)
5. Remove `ENCRYPTION_KEY_OLD`

### 4.4 Breach Assessment Queries
```sql
-- Recent critical/violation events
SELECT * FROM hipaa_audit_log
WHERE severity IN ('critical', 'violation')
AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;

-- PHI access by actor in last 24h
SELECT actor_id, actor_type, count(*), array_agg(DISTINCT event_type)
FROM hipaa_audit_log
WHERE created_at > now() - interval '24 hours'
GROUP BY actor_id, actor_type
ORDER BY count DESC;
```

---

## 5. Administrative Safeguards

### Required Policies (not implemented in code)
- [ ] Written HIPAA privacy policy
- [ ] Employee training program
- [ ] Designated Privacy Officer
- [ ] Designated Security Officer
- [ ] Risk assessment (annual)
- [ ] Sanction policy for violations
- [ ] Contingency/disaster recovery plan

### Workforce Requirements
- All staff with CRM access must complete HIPAA training
- Minimum necessary access principle: assign leads to specific users
- Terminate access immediately upon employee departure

---

## 6. Physical Safeguards

For cloud-hosted deployments:
- Supabase handles physical security for database infrastructure
- Vercel handles physical security for compute infrastructure
- Ensure BAAs cover physical security responsibilities
- Workstation security is the practice's responsibility

---

## 7. Compliance Checklist

### Technical (Implemented)
- [x] PII encryption at rest (AES-256-GCM)
- [x] Search hashes for encrypted field lookups
- [x] HIPAA audit logging for all PHI access
- [x] PHI scrubbing before AI processing
- [x] Prompt injection detection
- [x] Response compliance checking
- [x] TCPA consent tracking
- [x] CAN-SPAM unsubscribe
- [x] Rate limiting on all endpoints
- [x] Webhook signature verification
- [x] Row-Level Security (RLS)

### Administrative (Practice Responsibility)
- [ ] Signed BAAs with all vendors
- [ ] Written HIPAA policies
- [ ] Staff training
- [ ] Annual risk assessment
- [ ] Incident response team designated
- [ ] Business continuity plan
