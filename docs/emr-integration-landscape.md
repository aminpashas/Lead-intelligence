# EMR/PMS integration landscape — can one service plug us into "all EMRs"?

**Question:** competitors advertise "integrates with 40+ EMRs". Is there a service we can buy
that connects Lead Intelligence to all of them?

**Answer: no.** There is no vendor that covers all EMRs. The market splits into three
segments with disjoint middleware, and the leader in one segment has near-zero coverage in
the others. A "40+ EMR" badge is almost always three or four different mechanisms stacked
behind one marketing number.

This document maps the segments, names the credible vendors, and gives a per-vertical
recommendation. The companion doc — [`emr-adapter-refactor-plan.md`](./emr-adapter-refactor-plan.md)
— covers what we change in this repo so any of these choices plugs in without a rewrite.

> **Source confidence.** Vendor capability claims are cited from vendor sites and marked
> *(vendor claim)*. Pricing figures are third-party estimates from resale/analyst sites, not
> vendor rate cards, and are marked *(third-party estimate)*. Every number below needs a
> sales call to confirm before it drives a decision. Nothing here has been contract-verified.

---

## The three segments

### 1. Hospital / ambulatory — Epic, Cerner, athenahealth, eCW, Elation

The mature segment. Real standards (HL7v2, FHIR R4), real middleware, enterprise pricing.

| Vendor | Model | Coverage | Writeback | Cost |
|---|---|---|---|---|
| [Redox](https://www.invene.com/blog/redox-integration) | Managed integration platform | 85+ EMR vendors *(vendor claim)* | Yes — bidirectional, real-time workflow | ~$30k/yr small → $200k+/yr enterprise *(third-party estimate, [Vendr](https://www.vendr.com/marketplace/redox))* |
| Rhapsody / NextGen Connect (Mirth) | Interface engine you operate | Anything you build | Yes | Cheap license, expensive labor |
| [Health Gorilla](https://www.healthgorilla.com/) | TEFCA QHIN, network query | National networks | **No** | Per-query |
| [Particle](https://www.healthgorilla.com/), [Metriport](https://docs.metriport.com/ehr-apps/overview) | Record retrieval (Carequality/CommonWell) | National networks | **No** | Metriport is open source |
| [Flexpa](https://www.flexpa.com/) | Patient-access / payer (CARIN Blue Button) | Payers, not EMRs | **No** | Per-member |

**The trap:** Particle, Metriport, Health Gorilla, 1upHealth and Flexpa are *record retrieval*
networks. They return a patient's longitudinal history. They cannot write an appointment into
a practice's schedule. For Lead Intelligence — where the entire value is booking a consult and
reading back whether it happened — retrieval-only vendors are the wrong tool no matter how
good their coverage looks. Only Redox and self-run interface engines do bidirectional workflow.

**Verdict:** Redox is the only real buy here, and its pricing assumes health-system deal sizes.
It is not economic at per-clinic SaaS margins unless multi-location ambulatory becomes a
deliberate enterprise motion.

### 2. Dental / vet / small-practice PMS — where CareStack already lives

Hospital middleware does not reach this segment at all. Different aggregators, different
mechanism: most of these systems are **on-premise Windows servers**, so the "API" is a local
agent installed on the practice's server reading the database directly.

| Vendor | Coverage | Writeback | Notes |
|---|---|---|---|
| [Sikka ONE API](https://www.sikka.ai/oneapi) | 400+ PMS, ~90% of US/CA/AU dental+vet *(vendor claim)* | **Quote-only.** Silver/Gold/Platinum are read-only ([Sikka](https://www.sikkasoft.com/api-packages)) | The closest thing to "one service for this segment". Longest track record. |
| [Kolla](https://www.getkolla.com/solutions/pms-api) | Major dental PMS | Yes *(vendor claim)* | Positions on cost — claims ~70% below incumbents *(vendor claim)*. Newer. |
| [CRMBridge.ai](https://crmbridge.ai/) | 27+ dental PMS *(vendor claim)* | Yes *(vendor claim)* | Newest, thinnest track record. |
| [TensorLinks](https://www.tensorlinks.com/integrations/) | Dentrix, Eaglesoft, Open Dental, Curve, Denticon, **CareStack** | Varies | Overlaps our existing CareStack build. |

**The writeback catch is the whole story.** Sikka's standard tiers are read-only. We need to
*create appointments*, not just read them. That moves us to a custom quote and is the single
most important thing to pin down on a first call — a read-only aggregator cannot replace what
`pushAppointmentToCareStack` already does today.

**The hidden cost floor:** per-vendor gatekeeping sits underneath the aggregator. Eaglesoft
integration runs through Patterson Innovation Connection, reportedly **$3–5k upfront plus
monthly** *(third-party estimate)*. Aggregators pass this through. "One API" does not mean one
contract or one bill.

### 3. Aesthetics / medspa — PatientNow, Nextech, Symplast, Aesthetic Record, Boulevard, Zenoti

**There is no aggregator in this segment.** Nobody sells it. Research surfaced no unified API
covering these platforms, and no public developer documentation or open partner program for
Nextech, Symplast, Aesthetic Record, Boulevard, or Zenoti — integrations here are announced as
**bilateral partnerships**, e.g. [PatientNow ↔ Aesthetix CRM](https://markets.financialcontent.com/crain.businessinsurance/article/prlog-2025-4-10-the-ultimate-med-spa-growth-engine-patientnow-and-aesthetix-crm-announce-strategic-integration).

So a competitor's "40+ EMRs, including PatientNow" is not a purchased capability. It is
hand-built: direct partner APIs where a program exists, and screen-scraping / RPA agents where
it does not. That is a moat built by grinding, not one we can buy our way past — but it also
means **no competitor has an advantage here we cannot match with the same effort.**

**Verdict:** every aesthetics EMR is a bespoke adapter and a partnership conversation. Budget
per-EMR, not per-platform. Sequence by how many target practices each one unlocks.

---

## Decoding a "40+ EMRs" claim

Four mechanisms hide behind one number. They differ enormously in reliability and cost:

1. **Real REST/FHIR API** (cloud PMS — CareStack, Open Dental, Dentrix Ascend). Reliable,
   documented, versioned. What we already have with CareStack.
2. **Local DB agent** (on-prem — Dentrix, Eaglesoft). A Windows service on the practice server.
   Works, but you inherit install support, VPN/firewall issues, and PMS version drift.
3. **Partner/marketplace API behind a gate** (Nextech, Zenoti, Eaglesoft/PIC). Technically fine,
   commercially gated — enrollment fees, revenue share, approval cycles.
4. **RPA / screen-scraping.** Counts toward the logo number, breaks on UI updates, and is the
   most likely source of a competitor's long tail.

When evaluating any vendor, ask which mechanism backs *each* EMR we actually care about. The
headline count is not the deliverable.

---

## Recommendation

Given all three verticals are in scope:

| Vertical | Move | Why |
|---|---|---|
| **Dental** | Direct adapters for the top systems; price Sikka/Kolla **with writeback quoted** as the long-tail fallback | We already have CareStack direct and it works. Aggregators earn their keep on the tail, not the head. |
| **Aesthetics** | Direct adapters only, sequenced by practice count | No aggregator exists. Start with the one or two EMRs our actual pipeline demands. |
| **Ambulatory** | Defer. Revisit Redox only if an enterprise motion justifies a $30k+/yr floor | Pricing does not fit per-clinic SaaS margins today. |

**The strategic point:** the answer is not "buy one service." It is to make the *cost of adding
an EMR* low enough that adding the fifth one is a weekend, not a quarter. That is an
architecture problem in our repo, not a procurement problem — which is what the companion plan
addresses.

---

## Portfolio constraint — read before building

[`ECOSYSTEM.md`](../ECOSYSTEM.md) assigns multi-PMS connectivity to a shared package, **not to
this repo**:

| Workflow | System of record | Everyone else |
|---|---|---|
| Legacy PMS import (Dentrix/Eaglesoft/OpenDental) | shared `@dion/pms-connectors` | build once, share — don't re-parse |
| Clinical chart / EMR | **Dion Clinical** (planned) | don't store clinical records locally |

`@dion/pms-connectors` does not exist yet — it is absent from `package.json` and
`node_modules/`. So the practical reading is:

- **Lead Intelligence owns the consumer side** — the vendor-neutral port and the `ehr_*` tables
  that drive booking, availability, and lead-outcome attribution. That is squarely "Sales /
  lead CRM", which LI owns.
- **Per-vendor connectivity is portfolio-shared.** Whatever we build should be shaped so it can
  be lifted into `@dion/pms-connectors` later without dragging LI's schema along.
- **Do not accumulate clinical records here.** Our EHR reads exist to answer *did this lead
  book, show, and accept treatment* — attribution, not charting. Keep it that way.

This is why the refactor plan defines a **port in LI** and treats adapters as replaceable
implementations rather than building an EMR hub inside this repo.

---

## Open questions for vendor calls

1. **Sikka/Kolla:** what does writeback cost, which PMS support appointment *create*, and what
   is the latency between an appointment we create and it appearing in the practice's schedule?
2. **Sikka/Kolla:** who installs and supports the on-prem agent — them or us?
3. **Aesthetics EMRs:** does Nextech / PatientNow / Symplast have a partner API program at all,
   what are the commercial terms, and what is the approval timeline?
4. **All:** BAA terms and PHI residency — does patient data transit the vendor's infrastructure,
   and does that fit [`hipaa-compliance.md`](./hipaa-compliance.md)?
5. **All:** what happens on PMS version upgrades — who absorbs the breakage?

## Sources

- [Redox integration guide (Invene)](https://www.invene.com/blog/redox-integration) · [Redox pricing (Vendr)](https://www.vendr.com/marketplace/redox) · [Redox cost analysis (Taction)](https://www.tactionsoft.com/blog/redox-integration/)
- [Sikka ONE API](https://www.sikka.ai/oneapi) · [Sikka API packages & pricing](https://www.sikkasoft.com/api-packages) · [Sikka ONE API FAQ](https://help.sikka.ai/sikka-one-api-frequently-asked-questions)
- [Kolla PMS API](https://www.getkolla.com/solutions/pms-api) · [CRMBridge.ai](https://crmbridge.ai/) · [CRMBridge Eaglesoft/PIC costs](https://crmbridge.ai/integrations/eaglesoft) · [TensorLinks](https://www.tensorlinks.com/integrations/)
- [Health Gorilla](https://www.healthgorilla.com/) · [Metriport EHR apps](https://docs.metriport.com/ehr-apps/overview) · [Flexpa](https://www.flexpa.com/)
- [Top EMR integration tools 2026 (Latent)](https://www.latenthq.com/insights/top-emr-integration-tools-to-connect-healthcare-systems) · [Redox alternatives (Mindbowser)](https://www.mindbowser.com/redox-alternative/)
- [PatientNow ↔ Aesthetix CRM integration](https://markets.financialcontent.com/crain.businessinsurance/article/prlog-2025-4-10-the-ultimate-med-spa-growth-engine-patientnow-and-aesthetix-crm-announce-strategic-integration) · [Med spa EMR guide (Aesthetix)](https://aesthetixcrm.com/complete-guide-to-evaluating-best-emr-med-spa-plastic-surgery-practice/)
