# GHL → LI Phone & Comms Cutover Runbook

_Compiled 2026-07-20 from live probes of GHL, WhatConverts, Twilio, and LI prod. Goal: new leads never start conversations in GHL; every call/text is worked in Lead Intelligence._

## 1. What's actually happening today (verified live)

**Texts:** GHL is still auto-texting every new lead (first-touch "Hi! This is Dion Health…" / "Hi — this is Dr. Samadian's office…" observed going out repeatedly on 2026-07-20, latest 22:36 UTC). The lead's reply lands on the GHL number → the whole conversation lives in GHL. Staff are also texting/calling out of the GHL app (e.g. "Heather" follow-ups).

**Calls:** inbound calls land in GHL too (inbound call conversation at 22:12 UTC on 2026-07-20). LI has been blind to all of it since Jul 13 (GHL→LI message webhook dead).

**⚠️ Compliance note observed:** an inbound "Stop" (22:52:29) was followed 2 seconds later by an outbound text (22:52:31) from the GHL app. Likely crossed in flight, but STOP handling in GHL should be double-checked while it remains live.

## 2. Number inventory (the map)

### GHL sub-account `tCQuemUxY4FdXOZh18ip` (Dion Health SF) — 6 LeadConnector numbers
| Number | Name | Voice forwards to | Notes |
|---|---|---|---|
| +1 415-649-3523 | **Implant** | +1 415-329-4152 | **default number** — likely main SMS identity |
| +1 925-492-7470 | Texting # | +1 415-329-4152 | |
| +1 415-319-6406 | Cosmetic | +1 415-329-4152 | |
| +1 415-214-9837 | TY Page | +1 415-329-4152 | |
| +1 415-853-7404 | DNM | +1 415-329-4152 | |
| +1 424-252-3827 | Beverly Hills | +1 310-860-9311 | |

### Your own Twilio account (ACe522…)
| Number | Role | Voice | SMS |
|---|---|---|---|
| +1 415-886-1942 | **LI main line** | → LI `/api/voice/inbound` (Retell AI setter, auto-creates leads w/ voice consent) | → LI `/api/webhooks/twilio` via Messaging Service `MGf6d04811…` (verified healthy 2026-07-20) |
| +1 415-636-9655 | "Dion Pay – patient billing" | → **GHL** (`services.leadconnectorhq.com/phone-system/voice-call/inbound`) | — |

### WhatConverts tracking layer (account 61306 "Dion Health")
What the public publishes → where calls actually go (July call data):
- **dionhealth.com + TMJ site publish (415) 570-2841** → WC tracking → chains to +1 415-429-8769 (another WC number) → terminates at **+1 415-872-5116**
- **sfdentistry.com publishes (415) 599-3237** → WC tracking → **+1 415-421-2144**
- **DGS landing pages (dionhealthsf.com) publish (510) 408-9331** → WC tracking → **+1 415-825-6414**
- Other Dion Health WC numbers → +1 415-943-5808, +1 415-329-4152

**Open question:** the terminal destinations (+1 415-872-5116, +1 415-825-6414, +1 415-421-2144, +1 415-943-5808, +1 415-329-4152) are all Twilio-hosted VoIP but are NOT in your Twilio account and NOT in the SF GHL sub-account. Most likely they're LeadConnector numbers in another GHL sub-account (agency/whitelabel — WhatConverts is iframed under `app.seraphimconsulting.org`) or another Twilio-based phone system the front desk answers on. **Amin: check the agency-level GHL account (all sub-accounts → Phone Numbers), or ask GHL support to search these numbers (ticket text below includes this).** Whoever owns these owns the real voice front door.

## 3. Cutover sequence (order matters)

### Phase A — make LI able to catch new leads — ✅ DONE 2026-07-20
1. ✅ `autopilot_paused` flipped to `false` (org SF Dentistry `fa64e53c…`) — AI auto-replies are LIVE.
2. ✅ Three new-lead campaigns created + active (criteria: `status='new'`, has phone, `created_after 2026-07-20T23:00Z` — historical leads can never enroll):
   - **New Leads — Implants (AI Setter)** `d692752d…` — autopilot `auto`, send `live`. Opener + day-1 + day-3 follow-ups (exit on reply), then AI setter works replies autonomously.
   - **New Leads — TMJ (Review-first)** `ea7a2c0f…` — opener sends automatically; AI replies queue for human review (TMJ playbook not yet auto-approved).
   - **New Leads — Sleep Apnea (Review-first)** `631899fc…` — same pattern.
   - Send window 8am–8pm PT, 7 days. Enrollment via the 15-min campaigns cron; opener goes out on the same cron pass (typical lead→text latency ≤15–30 min).
   - Coverage gap (deliberate): new leads tagged cosmetic/veneers/other lines are not enrolled by these three; add a campaign per line when those verticals matter.

**✅ Verified end-to-end 2026-07-20:** test lead (Amin's phone) staged as a fresh `new` lead → 15-min cron auto-enrolled it → opener "Hi Amin, this is SF Dentistry — we just got your request about dental implants…" sent from +1 415-886-1942 → Twilio status **delivered**. Test artifacts cleaned up (lead restored, all 3 test enrollments exited).

Notes from verification:
- A lead matching multiple service lines can enroll in more than one campaign; the same-channel double-text guard suppressed the duplicate openers in the test (1 SMS went out, not 3). Watch for this on real TMJ+sleep combo leads.
- Prod `CRON_SECRET` differs from `.env.local` — you cannot fire crons manually from this machine; rely on the schedule.
- **Fix shipped 2026-07-21 (`87f97e5`, main):** the step `exit_condition` (exit on reply) used to set the enrollment `exited` — which also revoked the AI setter's send authorization (only `status='active'` enrollments authorize) at exactly the moment the lead engaged. AI-enabled campaigns now keep the enrollment active and just stop the steps (`next_step_at=null`); non-AI campaigns exit as before. Chloe's two reply-exited enrollments were reactivated in prod data; mario's stays exited (he texted STOP → `sms_opt_out=true`, propagated from GHL via the revived mirror).
- The `new_lead_follow_up` "New Lead Outreach" sequence (11 steps, enabled in DB) is **dormant** — prod `FOLLOWUP_SEQUENCES_ENABLED=""`. The three campaigns are LI's only first-touch engine; if that env var is ever set, de-duplicate the two engines first.

Until GHL is silenced (Phase B), new leads will briefly get BOTH GHL's and LI's opener — acceptable for the cutover window; send the Phase B ticket promptly.

### Phase B — silence GHL outbound automation (Amin: send ticket §4a)
Pauses all `Lead Nurture - *` workflow texts/emails. Keep inbound intact. Same window: staff stop working conversations in the GHL app and use LI instead.

### Phase C — move the numbers (Amin: send ticket §4b)
Port the 6 LeadConnector numbers into your own Twilio account (start with **Implant +1 415-649-3523** and **Texting # +1 925-492-7470** if staging). After each port completes, in Twilio:
- Voice URL → `https://lead-intelligence-jet.vercel.app/api/voice/inbound` (POST)
- Add the number to Messaging Service `MGf6d04811cd838cad5cbb51b9b3d42c6b` sender pool (inherits the VERIFIED A2P campaign; inbound SMS then flows to LI automatically)
- Interim (pre-port): set each GHL number's forwarding to +1 415-886-1942 so LI answers while the port is pending — one setting per number in GHL Phone Settings (UI-only).

### Phase D — repoint the tracking layer
In WhatConverts (UI, no API for this): change each tracking number's **destination/forwarding number** to **+1 415-886-1942** (or to the ported numbers once they're LI-wired). This flips all website/LP/ad call traffic into LI **while preserving WC → DGS → LI lead attribution**. Do NOT remove WC tracking — it feeds attribution.

### Phase E — clean up
- Repoint or retire +1 415-636-9655 "Dion Pay" (its voice still goes to GHL).
- Audit Google Ads call assets + Google Business Profile + Meta ad CTAs for any directly-published GHL number.
- Leave the Meta-form lead pipeline (Meta → GHL → DGS → LI) ALONE — it's the lead-record backbone, unrelated to phones.
- After 30 days of quiet, decide whether to keep the GHL sub-account as a passive capture shell.

## 3b. Google Ads call-asset audit + fix — ✅ DONE 2026-07-20

Swept all Dion Google Ads accounts (MCC 1295578723 "Dion Health Media") via API:
- **FOUND THE LIVE LEAK:** SF Dentistry account (4034390974), ENABLED campaign **"TMJ Google Search V2"** had a call asset dialing **(415) 853-7404 = the GHL "DNM" number**. This was the active "new lead calls the GHL number" path from Google.
- **FIXED via API:** created call asset `397082395404` = **(415) 570-2841** (the WhatConverts TMJ tracking number — same destination website callers get, full WC → DGS → LI lead attribution) and swapped it onto the campaign; the GHL-number link is now REMOVED. Rollback: relink asset 266678737795.
- GHL "Implant" number asset (415) 649-3523 exists but is linked nowhere (orphan) — no action needed.
- Remaining GHL/unknown numbers sit only on **PAUSED** campaigns: (415) 853-7404 on old TMJ campaigns, (833) 372-9063 on Cosmetic, (925) 255-9741 on LANAP, (415) 872-5116 on old TMJ. **If any of these campaigns is ever re-enabled, swap its call asset first.**
- Account-wide (customer-level) call asset (415) 421-2144 is ENABLED — one of the unidentified Twilio numbers (likely front desk); resolve its ownership via the ticket below.

## 4. Ready-to-send GHL support requests — ✅ DRAFTED IN GMAIL 2026-07-20

Both tickets below are sitting in Gmail drafts addressed to support@gohighlevel.com — review and hit send. Note: if your GHL access is under the agency whitelabel (app.seraphimconsulting.org), GHL corporate may route you to the agency owner — same request text applies.

The port-out draft also asks support to set the interim voice forwarding (Phase C interim) since the public API has no write access to phone settings. To do it yourself instead: GHL → Settings → Phone Numbers → edit each SF number → Call Forwarding → +1 415-886-1942.

### 4a. Pause all outbound automation (send now, Phase B)
> Subject: Pause ALL outbound automated SMS + email — sub-account tCQuemUxY4FdXOZh18ip
>
> Hi — for sub-account **tCQuemUxY4FdXOZh18ip** (Dion Health, San Francisco), please pause/unpublish **every workflow that sends SMS or email to contacts** (notably the "Lead Nurture - Full-Arch", "Lead Nurture - Full-Arch - 2nd message", "Lead Nurture - TMJ", "1 Month - Lead Nurture - TMJ" workflows and any other workflow with an SMS/email action targeting contacts). Please keep **inbound** messaging and staff notifications (e.g. "Notification", "Kortni Lead Notification Email", Meta CAPI workflows) intact. We are migrating outbound communication to another system and need GHL to stop initiating patient messages. Please confirm the list of workflows paused.

### 4b. Port-out request (Phase C)
> Subject: Port-out request — 6 LeadConnector numbers from sub-account tCQuemUxY4FdXOZh18ip
>
> I'd like to port the following numbers OUT of LeadConnector/GHL to my own Twilio account (I am the account owner and can provide LOA/billing verification): +14156493523, +19254927470, +14153196406, +14152149837, +14158537404, +14242523827. Please advise the port-out process and provide the account numbers/PINs needed for the winning-carrier (Twilio) port request.
>
> Separately: please tell me whether these numbers exist in ANY sub-account under my agency, and if so which: +14158725116, +14158256414, +14154212144, +14159435808, +14153294152, +13108609311, +13108887797.

## 5. LI switches to flip at cutover (Claude can do these on request)
- Activate real new-lead campaign(s) (auto + live + ai_enabled) — **must precede everything**
- `organizations.autopilot_paused → false` for `fa64e53c…`
- After ports: Twilio voice/SMS wiring per Phase C (scriptable via Twilio API)
- Optional: re-arm the GHL conversation mirror only if GHL stays as passive capture (webhook broken since Jul 13 — see `ghl-ingest-blackout-since-jul13`)
