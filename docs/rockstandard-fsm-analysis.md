# RockStandard Suite vs. ServiceTitan, Jobber, Housecall Pro

**Feature parity analysis & strategic build roadmap**

Prepared for: Ross Wearden / RockStandard Suite (Pzip, Pquote, Psupp)
Date: May 9, 2026
Scope: Where industry FSM platforms set the bar, where RockStandard has white space, and what to build to deliver more customer value per dollar while staying aligned with industry direction.

---

## 1. Executive summary

The three industry apps in the ad — ServiceTitan, Jobber, and Housecall Pro — are horizontal field service management (FSM) platforms. They converge on a common feature bundle: scheduling, dispatching, quoting, invoicing, payments, CRM, customer communications, marketing automation, and reporting. The differences are tier and depth, not category.

**Pzip, Pquote, and Psupp are not direct FSM replacements** — they're best understood as three vertical wedges:

- **Pzip** = CRM + multi-location route/bid intelligence (overlaps with FSM CRM modules)
- **Pquote** = Quoting/proposals with linear-foot QSR Pricing Optimizer (overlaps with FSM quoting modules)
- **Psupp** = Equipment diagnostics + agentic technician copilot (no direct competitor in any of the three)

The strategic play is **not to replicate FSM breadth**. It's to (1) close the painful gaps that horizontal tools can't fill for multi-location commercial accounts, (2) deepen Psupp's moat (which is genuinely unique), and (3) build narrow integration bridges so Pzip/Pquote complement existing FSM stacks rather than fighting them.

---

## 2. Industry feature inventory

### 2.1 ServiceTitan (enterprise tier)

Pricing: starts ~$398/month, custom-quoted, typically $400+/user/month for full stack. Implementation fees apply.

**Core platform**

- Work order management
- Scheduling, dispatching, drag-and-drop dispatch board
- GPS tracking, technician location
- Customer management (CRM) with full job history
- Inventory management (parts across vehicles and warehouses)
- Invoicing, billing, payments
- QuickBooks / Sage Intacct ERP integration
- Reporting and BI dashboards (KPIs, technician performance, financial)
- Mobile apps for field technicians

**Commercial / multi-location specific**

- Service agreement management (recurring contracts, renewals)
- Equipment tracking with warranty and service history
- Multi-tenant / multi-location billing
- Customer Portal 2.0 (24/7 self-service: view history, equipment, approve quotes, schedule)
- Commercial CRM with lead segmentation and automation
- Equipment Tasking (step-by-step technician workflows on specific assets)

**AI and automation (2025-2026 push)**

- **Atlas** AI assistant — uses customer data + automations for end-to-end workflows
- AI-powered equipment troubleshooting assistant (manuals, parts lookup) — *direct overlap with Psupp*
- AI Voice Agents for inbound call handling
- SMS Booking Agent
- Smarter Routing (AI route building)
- Adaptive Capacity scheduling with strategic rules
- Auto-adjust job duration based on completion patterns

**Financial stack**

- Tap to Pay, Pay by Bank, tip collection
- Embedded financing (with auto-fallback to second lender on rejection)
- Accounts payable automation, 3-way matching for vendor bills
- Payroll, timesheets

**Field operations**

- Digital forms for compliance / standardized workflows
- Photo capture for issues and upsell opportunities
- Crew scheduling and crew timekeeping (commercial/construction)
- Project budgeting with variance tracking

**Marketing & growth**

- Marketing Pro with campaign recommendations
- Call recording and call analytics

---

### 2.2 Jobber (SMB tier)

Pricing: $29–$249/month tiered (Core, Connect, Grow, Plus). Per-user pricing on team plans.

**Core platform**

- Quoting with templates, line items, optional tiers, photo attachments
- Auto-conversion of approved quotes into jobs
- Drag-and-drop scheduling and dispatching
- Job management, recurring jobs
- Invoicing, batch invoicing, automated follow-ups
- Online payments, deposits, tips
- Time tracking
- Route optimization
- Expense tracking
- Mobile app (iOS/Android)
- QuickBooks Online integration

**Customer experience**

- **Client Hub** — self-serve portal: approve quotes, request changes, see appointments, pay, sign, refer friends
- Online booking on website / social
- Custom request forms
- Automated text and email reminders
- Customer feedback surveys
- "On My Way" texts from technicians

**CRM and sales**

- Client database with notes, tags, history
- Lead tagging (separate from active clients)
- Sales pipeline (beta, late 2025) — Kanban-style
- Quote follow-up automation

**AI (Jobber Copilot)**

- Recommendations based on business activity
- AI Receptionist (inbound calls and texts)
- Quote/job suggestions

**Marketing**

- Automated email campaigns
- Referral programs
- Review request automation

**Reporting**

- Standard reports (visibly weaker than ServiceTitan per reviewer feedback)

---

### 2.3 Housecall Pro (mass-market SMB)

Pricing: $59–$229/month (Basic, Essentials, MAX). Custom pricing at top tier.

**Core platform**

- Drag-and-drop scheduling and dispatching
- Recurring jobs
- Mobile invoicing, on-site payment processing
- Estimates and proposals with pre-loaded price book
- Customer database with job history, tags, notes
- GPS tracking (Essentials+)
- Service area definition
- Time tracking and timesheets
- QuickBooks Online sync (with new control over sync timing)
- Asset management with QR code scanning

**Customer experience**

- Online booking widget
- Automated appointment reminders, ETA notifications
- Customer portal
- Review request and reputation management
- Website reviews widget (customizable)

**Marketing & sales**

- Email marketing campaigns with exit logic and triggers
- Lead intake from Thumbtack
- Recurring discounts in Price Book
- Housecall Pro Voice (call categorization, custom call reasons)
- Postcard / direct mail integrations

**AI (newer, mixed reviews)**

- AI assistance in automation
- AI-driven job suggestions
- Voice-to-text job notes

**Operations**

- Photo upload with auto-retry in low-signal areas
- Payroll (newly expanded, Feb 2026 release)
- Custom branding on customer comms

---

### 2.4 Cross-platform feature consensus

Every modern FSM platform now offers, as table stakes:

1. Drag-and-drop scheduling
2. CRM with job history
3. Quoting with auto-conversion to jobs
4. Online customer portal / client hub
5. Online booking
6. Automated reminders (text + email)
7. Mobile invoicing and payments
8. QuickBooks integration
9. GPS tracking
10. Photo documentation on jobs
11. Review request automation
12. AI assistant (some flavor)
13. Recurring job/contract management
14. Marketing automation (campaigns, follow-ups)
15. Reporting dashboards

**The 2026 industry direction is unmistakable:** AI-powered assistants embedded in every workflow, deeper financial services (financing, AP automation, embedded payments), and commercial/multi-location capabilities catching up with residential.

---

## 3. RockStandard Suite — current capabilities

### 3.1 Pzip / Zipper CRM (pzip.ai)

**Confirmed capabilities**

- CRM with lead pipeline
- Multi-location route planning (Texas Starbucks 61-location route plan recently built and formatted for import)
- Google OAuth, Railway-deployed, Supabase backend

**Inferred / aspirational**

- Pipeline management for B2B commercial sales cycles
- Multi-location bid coordination

### 3.2 Pquote (pquote.ai)

**Confirmed capabilities**

- Quoting and proposals
- Differentiated wedge: linear-foot QSR pricing via the **PO (Pricing Optimizer)** within QMach — distinct from standard sqft/lf quoting
- Multi-location quoting capability

### 3.3 Psupp / Pippy (psupp.ai)

**Confirmed capabilities**

- Equipment diagnostics
- 282+ indexed manufacturer PDFs
- Claude API agentic tool loop (multi-step troubleshooting, parts lookup, manual retrieval)
- Postgres backend
- The closest enterprise analog is ServiceTitan's new AI equipment troubleshooting assistant — but Psupp is purpose-built and deeper in this single domain

---

## 4. Side-by-side feature matrix

Legend: ✅ = strong / native, 🟡 = partial / basic, ❌ = not present, 🚀 = differentiated strength

### 4.1 Quoting & estimating

| Feature                             | ServiceTitan | Jobber | Housecall Pro | Pzip | Pquote  | Psupp |
| ----------------------------------- | ------------ | ------ | ------------- | ---- | ------- | ----- |
| Standard quote builder              | ✅            | ✅      | ✅             | ❌    | ✅       | ❌     |
| Quote templates / price book        | ✅            | ✅      | ✅             | ❌    | ✅       | ❌     |
| Auto-convert quote → job            | ✅            | ✅      | ✅             | 🟡    | 🟡       | ❌     |
| Photo attachments on quotes         | ✅            | ✅      | ✅             | ❌    | 🟡       | ❌     |
| Tiered / "good-better-best" options | ✅            | ✅      | ✅             | ❌    | 🟡       | ❌     |
| **Linear-foot QSR pricing**         | ❌            | ❌      | ❌             | ❌    | 🚀 (PO) | ❌     |
| **Multi-location bid roll-up**      | 🟡            | ❌      | ❌             | 🚀    | 🚀       | ❌     |
| Online quote approval / e-sign      | ✅            | ✅      | ✅             | ❌    | 🟡       | ❌     |
| Margin visibility on estimates      | ✅            | ✅      | 🟡             | ❌    | 🟡       | ❌     |
| Property data / Street View pull    | 🟡            | 🟡      | 🟡             | ❌    | ❌       | ❌     |

### 4.2 CRM & customer management

| Feature                                 | ServiceTitan | Jobber   | Housecall Pro | Pzip | Pquote | Psupp |
| --------------------------------------- | ------------ | -------- | ------------- | ---- | ------ | ----- |
| Lead pipeline / deal tracking           | ✅            | 🟡 (beta) | 🟡             | ✅    | ❌      | ❌     |
| Contact and company records             | ✅            | ✅        | ✅             | ✅    | ❌      | ❌     |
| Job and service history                 | ✅            | ✅        | ✅             | 🟡    | ❌      | ❌     |
| Tags, notes, segmentation               | ✅            | ✅        | ✅             | 🟡    | ❌      | ❌     |
| **Multi-location account hierarchy**    | ✅            | ❌        | ❌             | 🚀    | 🚀      | ❌     |
| Equipment / asset tracking per customer | ✅            | 🟡        | ✅             | ❌    | ❌      | 🚀     |
| Customer portal / self-service hub      | ✅            | ✅        | ✅             | ❌    | ❌      | ❌     |
| Automated follow-ups                    | ✅            | ✅        | ✅             | 🟡    | ❌      | ❌     |
| Review requests                         | ✅            | ✅        | ✅             | ❌    | ❌      | ❌     |

### 4.3 Scheduling, dispatching, field ops

| Feature                              | ServiceTitan | Jobber | Housecall Pro | Pzip          | Pquote | Psupp |
| ------------------------------------ | ------------ | ------ | ------------- | ------------- | ------ | ----- |
| Drag-and-drop scheduling             | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |
| Recurring jobs                       | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |
| Route optimization                   | ✅            | ✅      | ✅             | 🚀 (multi-loc) | ❌      | ❌     |
| GPS tracking                         | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |
| Mobile field app                     | ✅            | ✅      | ✅             | ❌             | ❌      | 🟡     |
| Digital forms / checklists           | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |
| **Photo documentation per location** | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |
| **Brand-compliance reporting**       | 🟡            | ❌      | ❌             | ❌             | ❌      | ❌     |
| Time tracking                        | ✅            | ✅      | ✅             | ❌             | ❌      | ❌     |

### 4.4 Equipment & technical knowledge

| Feature                            | ServiceTitan      | Jobber | Housecall Pro | Pzip | Pquote | Psupp          |
| ---------------------------------- | ----------------- | ------ | ------------- | ---- | ------ | -------------- |
| Equipment registry per customer    | ✅                 | 🟡      | ✅             | ❌    | ❌      | ✅              |
| Warranty tracking                  | ✅                 | ❌      | 🟡             | ❌    | ❌      | 🟡              |
| **Indexed manufacturer manuals**   | 🟡 (new)           | ❌      | ❌             | ❌    | ❌      | 🚀 (282+ PDFs) |
| **AI agentic troubleshooting**     | 🟡 (Atlas, broad)  | ❌      | ❌             | ❌    | ❌      | 🚀              |
| Parts lookup with manual cross-ref | 🟡                 | ❌      | ❌             | ❌    | ❌      | ✅              |
| Service history tied to equipment  | ✅                 | 🟡      | ✅             | ❌    | ❌      | 🟡              |

### 4.5 Financial & billing

| Feature                          | ServiceTitan | Jobber | Housecall Pro | Pzip | Pquote | Psupp |
| -------------------------------- | ------------ | ------ | ------------- | ---- | ------ | ----- |
| Mobile invoicing                 | ✅            | ✅      | ✅             | ❌    | 🟡      | ❌     |
| Online payments                  | ✅            | ✅      | ✅             | ❌    | 🟡      | ❌     |
| Tap to Pay                       | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| Embedded financing               | ✅            | ❌      | ❌             | ❌    | ❌      | ❌     |
| QuickBooks integration           | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| Multi-tenant / multi-loc billing | ✅            | ❌      | ❌             | 🟡    | 🟡      | ❌     |
| Recurring billing for contracts  | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| AP automation                    | ✅            | ❌      | 🟡             | ❌    | ❌      | ❌     |

### 4.6 Marketing & customer growth

| Feature                   | ServiceTitan | Jobber | Housecall Pro | Pzip | Pquote | Psupp |
| ------------------------- | ------------ | ------ | ------------- | ---- | ------ | ----- |
| Email campaigns           | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| SMS automation            | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| Review request automation | ✅            | ✅      | ✅             | ❌    | ❌      | ❌     |
| Online booking widget     | ✅            | ✅      | ✅             | ❌    | 🟡      | ❌     |
| Referral program          | 🟡            | ✅      | 🟡             | ❌    | ❌      | ❌     |
| AI Voice / SMS agent      | ✅            | ✅      | 🟡             | ❌    | ❌      | ❌     |

### 4.7 AI & automation (2026 frontier)

| Feature                      | ServiceTitan | Jobber    | Housecall Pro | Pzip | Pquote | Psupp        |
| ---------------------------- | ------------ | --------- | ------------- | ---- | ------ | ------------ |
| AI assistant                 | ✅ Atlas      | ✅ Copilot | 🟡             | ❌    | ❌      | 🚀 (agentic)  |
| AI quote generation          | 🟡            | 🟡         | 🟡             | ❌    | ❌      | ❌            |
| AI dispatch optimization     | ✅            | 🟡         | ❌             | ❌    | ❌      | ❌            |
| **AI equipment diagnostics** | 🟡 (new)      | ❌         | ❌             | ❌    | ❌      | 🚀            |
| Natural-language CRM control | 🟡            | 🟡         | ❌             | ❌    | ❌      | ❌            |

---

## 5. Where RockStandard already wins

Five capabilities exist in RockStandard that the Big Three either don't have or do poorly:

1. **Linear-foot QSR pricing (Pquote PO)** — Pquote's PO is genuinely differentiated. None of the three FSMs handle restaurant linear-foot pricing natively. This is a vertical wedge.
2. **Multi-location bid coordination** — Pzip's route planning for 61 Starbucks locations is the kind of work Jobber/Housecall Pro simply aren't built for. ServiceTitan can do it, but at $400+/user/month and an enterprise implementation.
3. **Agentic equipment diagnostics with indexed manuals (Psupp)** — 282+ PDFs indexed with a Claude agentic loop is a deeper, narrower implementation than ServiceTitan's broad Atlas. None of the SMB platforms have anything like it.
4. **Niche commercial focus** — built around Brinker / Bloomin' Brands / Starbucks-style multi-unit accounts, not residential HVAC / plumbing.
5. **Builder-operator pricing model** — RockStandard can undercut Jobber's $99–$249/month while delivering features the Big Three charge enterprise prices for.

---

## 6. Where customer value is being left on the table

These are the gaps where RockStandard currently asks customers to leave the suite to get something they need. Each one is a candidate for "build to industry parity" — not to be the best, but to remove a reason to look elsewhere.

### 6.1 Highest priority — close to industry table stakes

| Gap                            | Current state | Industry standard | Build target                                                                               |
| ------------------------------ | ------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| Customer portal / client hub   | None          | All 3 have it     | Pzip: lightweight portal — view bids, approve quotes, see route status, photo deliverables |
| Online quote approval / e-sign | Partial       | All 3 have it     | Pquote: one-click approve + signature capture                                              |
| Photo documentation on jobs    | None          | All 3 have it     | Pzip: photo upload per location with timestamp/GPS, auto-attach to job/account             |
| Recurring contract management  | None          | All 3 have it     | Pzip: recurring service agreements with auto-renewal alerts                                |
| QuickBooks integration         | None          | All 3 have it     | Pquote → QBO invoice push (most-asked SMB feature)                                         |
| Automated review requests      | None          | All 3 have it     | Pzip: post-job text/email asking for Google review                                         |

### 6.2 Medium priority — meaningful upsell

| Gap                                 | Current state    | Industry standard    | Build target                                                                                                            |
| ----------------------------------- | ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Online payments / Stripe            | Partial          | All 3 have it        | Pquote: payment links on approved quotes, deposits                                                                      |
| Drag-and-drop scheduling            | None             | All 3 have it        | Pzip: simple calendar view assigning jobs to crews/days                                                                 |
| Mobile field app                    | None             | All 3 have it        | Pzip / Psupp: PWA or React Native app for on-site use                                                                   |
| Brand-compliance reporting          | None             | ServiceTitan partial | Pzip: standardized PDF/photo report per location, branded for the customer (genuine differentiator for SPW positioning) |
| Equipment registry tied to customer | Psupp standalone | All 3 have it        | Connect Psupp's equipment data to Pzip customer records                                                                 |

### 6.3 Strategic / longer-horizon

| Gap                                          | Current state    | Industry standard                   | Build target                                                                                                                        |
| -------------------------------------------- | ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| AI equipment diagnostics inside FSM workflow | Psupp standalone | ServiceTitan launching Atlas        | Productize Psupp as an embeddable widget / API that other FSMs can integrate (turn the moat into a wedge into their installed base) |
| Natural-language CRM control                 | None             | ServiceTitan, QuoteIQ               | Pzip: "show me all Brinker locations due for service this month" via Claude API                                                     |
| AI quote generation                          | None             | All 3 starting                      | Pquote: photo or address → AI-suggested quote based on PO logic                                                                     |
| AI inbound voice agent                       | None             | ServiceTitan, Jobber, Housecall Pro | Lower priority for B2B commercial, but watch for pull from customers                                                                |

---

## 7. What to NOT build

The temptation when comparing to the Big Three is to chase parity across the board. **Don't.** Several feature sets are bad bets for RockStandard:

- **Embedded financing** — regulated, capital-intensive, not a fit for B2B commercial accounts (which pay net-30 on invoice, not financing)
- **Payroll** — solved problem, every FSM that built it regretted the support burden
- **Inventory management at parts level** — irrelevant for exterior facility maintenance; relevant only if Psupp's customer base demands it
- **AI Voice Agent for inbound** — residential pain point, not commercial
- **Direct mail / postcard marketing** — not a B2B commercial channel
- **Generic AI dispatch optimization** — Pzip's multi-location bid intelligence is more valuable than copying Atlas's general routing AI

---

## 8. Strategic build roadmap

### Phase 1 (next 90 days) — close table-stakes gaps

Goal: customers stop saying "Pzip is great BUT I can't approve quotes online" or "I have to leave Pzip to send invoices." Every gap here is a non-negotiable for FSM buyers in 2026.

1. **Pquote: online quote approval + e-sign + Stripe payment link** (1–2 weeks)
2. **Pzip: customer portal (read-only first)** — show the customer their accounts, locations, bid status, completed jobs (2–3 weeks)
3. **Pzip: photo documentation per location** — upload, GPS-tag, attach to account (2 weeks)
4. **Pquote → QuickBooks Online invoice push** (1 week, QBO API is well-documented)
5. **Pzip: post-job review request automation** (1 week)

### Phase 2 (90–180 days) — vertical depth in multi-location

Goal: become indispensable for multi-unit facility maintenance accounts (Starbucks/Chili's/Outback class).

1. **Pzip: branded multi-location compliance reports** — auto-generate PDF showing all locations serviced, photos, before/after, brand standard met. This becomes a sales weapon.
2. **Pzip: recurring service agreement engine** — schedule the next 12 months of service across 106 locations, route by proximity
3. **Pzip + Psupp integration** — link equipment records on customer accounts; technicians on site can pull up Psupp diagnostic on the equipment they're servicing
4. **Pquote: AI-assisted quote from photo + address** — leverages Pquote's PO logic with Claude vision

### Phase 3 (180–365 days) — productize the Psupp moat

Goal: turn Psupp from internal tool into a product line.

1. **Psupp as an embeddable widget / API** — let ServiceTitan / Jobber / Housecall Pro shops plug Psupp into their workflow without leaving their FSM
2. **Expand manual library** beyond current vertical (more equipment categories)
3. **Psupp public knowledge layer** — searchable troubleshooting database (SEO play, lead generation for SPW)

### Phase 4 (year 2) — integration, not replacement

Goal: position RockStandard alongside FSM, not against it.

1. **Native integrations** with Jobber and Housecall Pro (their APIs are open, ServiceTitan's is harder)
2. **Data sync** — Pzip sends won deals into Jobber/HCP as jobs; Psupp pulls equipment data from FSM customer records
3. **Co-marketing** — RockStandard becomes the "vertical layer" for FSM users in commercial multi-location work

---

## 9. Pricing alignment with industry

For reference, here's where the industry sits and where RockStandard could position:

| Segment                     | Industry price range                              | RockStandard target            |
| --------------------------- | ------------------------------------------------- | ------------------------------ |
| Solo / micro                | $29–$79/mo (Jobber Core, HCP Basic)               | $19–$39/mo                     |
| Small team (2–10)           | $99–$249/mo (Jobber Connect/Grow, HCP Essentials) | $79–$149/mo                    |
| Multi-location / commercial | $400+/user/mo (ServiceTitan)                      | $199–$399/mo flat              |
| Psupp standalone            | n/a (no comparable product)                       | $49–$99/mo per technician seat |

Undercutting Jobber and Housecall Pro at the SMB tier is realistic and defensible for a leaner stack. The commercial multi-location tier — where Pzip's route intelligence and brand-compliance reporting live — is where a real premium can be charged because no SMB-priced competitor exists.

---

## 10. Bottom line

The three apps in the ad set the floor for what FSM customers expect. RockStandard can match that floor on the table-stakes features (portal, e-sign, QBO sync, photo docs, review requests) without much engineering, and that work is non-optional — it's the price of admission.

The ceiling — and the reason RockStandard exists — is in three places where the Big Three are weak:

1. **Multi-location commercial coordination** (Pzip's 61-Starbucks-route work is the proof)
2. **Linear-foot QSR pricing** (Pquote's PO)
3. **Agentic equipment diagnostics** (Psupp)

Build the floor in 90 days. Deepen the ceiling for the next 12 months. Do not try to out-FSM ServiceTitan, Jobber, or Housecall Pro at their own game.
