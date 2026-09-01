# Project Wingman — Master Roadmap

**Working title.** Real brand name TBD (finalist candidates: Chanakya, Niti, Artha, Amatya, Sutradhar).

**Product positioning.** AI Chief of Staff for founders, CEOs, and operators with cognitive overload. A second brain that reads everything coming in (email, Slack, calendar, projects, analytics), surfaces only what matters, drafts what's routine in the user's voice, prepares your weekly and monthly cadence, and over time develops compound knowledge of the user's business and relationships.

**Year 1 target.** 400 paying users, ₹XX crore ARR.

**Year 2 target.** 1,500-2,000 paying users via international expansion (US, UK, Singapore), ₹XX crore ARR.

---

## The Six Versions

### v0 — Weekender Slice

Gmail inbox triage with classification + draft replies. Single integration, single workflow.

**Wedge:** Replace 30-90 min daily inbox triage with 5-min review of pre-classified + drafted replies.

**Pricing:** ₹999/month, "Founding 100" lifetime lock-in for first 100 users.

**Target:** 50-100 paying users by Weekender submission.

**Status:** In progress. Day 3 of 6.

---

### v1 — Foundation (months 1-3 post-launch)

Expand beyond Gmail. Add Slack, Notion, Google Calendar as ingestion sources.

**Features:**
- Refined inbox triage (multi-source, not just Gmail)
- Weekly/monthly/quarterly plan generation across all workstreams
- Voice/text → first-level OKRs (native, no integrations yet)

**Pricing:** ₹2,499/month for Tier 1 (Solo Founder).

**Target:** 25-75 paying users.

---

### v2 — Memory & Intelligence (months 4-5)

The compound moat starts.

**Features:**
- Personal CRM / relationship memory (every meeting + email + Slack DM ingested, queryable by name or topic)
- Competitive intelligence digest (curated weekly news for the sector, scored by relevance to active workstreams)
- Voice-drafted email replies refined (better tone matching, multi-thread context)
- Sheets + analytics tools (PostHog, Mixpanel) as ingestion sources

**Pricing:** Tier 1 unchanged at ₹2,499/month.

**Target:** 75-150 paying users.

---

### v3 — Stakeholder Communication (months 6-7)

The version that justifies premium pricing.

**Features:**
- Stakeholder communication cadence ("you haven't messaged Investor X in 6 weeks")
- Investor/board update auto-drafts pulled from operating data
- Calendar intelligence + protection (overload alerts, deep work block reservation)
- Slack drafting (full version)
- One OKR tool integration (Mooncamp first for India, Lattice for global)

**Pricing:** Tier 2 Founder Plus opens at ₹4,999/month.

**Target:** 150-250 paying users. Tier 2 should be 30-40% of paying base.

---

### v4 — Decision Memory & Knowledge (months 8-9)

The compound knowledge layer matures.

**Features:**
- Decision log with premortem/postmortem prompts
- Reading & learning synthesis (highlighted articles, podcasts, saved tweets surfaced contextually)
- Additional OKR tool integrations (Lattice, Notion-based templates, custom Sheets)
- Hiring pipeline tracker with cadence reminders

**Pricing:** Tier 3 Founder Premium opens at ₹9,999/month with 1 EA seat included.

**Target:** 250-350 paying users. Tier 3 should be 15-25% of paying base.

---

### v5 — Team Leverage & Multi-User (months 10-11)

The product scales beyond the solo founder.

**Features:**
- Team mood / direct report check-in tracker
- Strategic thinking trigger (weekly/monthly reflection prompts with framework support)
- Multi-user expansion (founder can add 1-2 EA/CoS seats at ₹2,499 each, sharing same context base)
- Public API + webhook layer for custom integrations

**Pricing:** Tier 3 features. Additional seats at ₹2,499 each.

**Target:** 400 paying users by month 12. Year 1 ARR ₹XX crore.

---

### v6 — Wellness Layer (month 12+, conditional)

Optional, demand-driven.

**Features:**
- Mental health + emotion tracking using public frameworks (NOT Mochary-branded for legal reasons)
- Correlation insights between sleep/exercise/meeting types and decision quality
- Optional: standalone sub-brand for the wellness layer

**Conditional ship rule:** Build only if v1-v5 user research shows founders explicitly asking for it. May ship as a sister product instead of a feature inside Wingman.

---

## Core Modules — Cross-Cutting View

The 15+ features above cluster into 6 functional modules. This is often the cleaner architecture for thinking about the product:

### Module 1 — Ingestion & Sync

The data plumbing. Foundation everything else rides on.

**Sources across versions:** Gmail (v0), Slack + Notion + Calendar (v1), Sheets + PostHog/Mixpanel analytics (v2).

**Ingestion patterns:** Real-time webhook (Slack), polled fetch (Gmail), daily sync (Notion, Sheets), event-based (Calendar).

---

### Module 2 — Triage & Surfacing

What does the user see when they open the app? The daily-use surface.

**Components:** Inbox classification (v0), calendar intelligence (v3), stakeholder cadence tracking (v3), reading synthesis surfacing (v4).

**Architectural principle:** Surface only the 10-20% of input that demands attention. Hide the rest unless explicitly searched.

---

### Module 3 — Drafting & Voice

Output generation in user's voice.

**Components:** Email drafts (v0), Slack drafts (v3), investor reports (v3), board updates (v3), weekly status emails (v1).

**Architectural principle:** Always draft, never auto-send. User is in the loop for every external communication.

---

### Module 4 — Planning & Strategy

Cadence rituals.

**Components:** Weekly/monthly/quarterly plans (v1), OKR extraction from voice memos (v1), strategic reflection prompts (v5), decision logs + premortems (v4).

**Architectural principle:** Generate proactively (push), don't wait for user to ask (pull).

---

### Module 5 — Knowledge & Memory

The compound layer — the moat.

**Components:** Personal CRM (v2), reading synthesis (v4), decision archive (v4), competitive intel (v2).

**Architectural principle:** Every interaction enriches the layer. The longer a user runs Wingman, the more valuable this becomes for them specifically. Switching cost compounds.

---

### Module 6 — Team & Wellness

Extension layer. Lower priority, only if user signal demands.

**Components:** Direct report tracking (v5), multi-user seats (v5), mental health tracker (v6), founder energy correlations (v6).

---

## Pricing Tiers (stable across versions)

| Tier | Price | Available from | Includes |
|------|-------|----------------|----------|
| Tier 1 Solo Founder | ₹2,499/month | v1 | v0 + v1 + v2 features |
| Tier 2 Founder Plus | ₹4,999/month | v3 | v1 + v2 + v3 features |
| Tier 3 Founder Premium | ₹9,999/month | v4 | All features + 1 EA seat (v5+) |

**Founding 100 lock-in:** First 100 paying users at v0/v1 lock at their original price for life. Loyalty + word-of-mouth lever.

**International pricing (year 2):** Tier 1 $30/month, Tier 2 $60/month, Tier 3 $120/month.

---

## ICP & Distribution

**Year 1 ICP:** Founder/CEO of seed to Series A Indian SaaS startup, 5-25 employees, ₹2-10 cr ARR. Cognitive overload from too many workstreams. ₹2-5 lakh/month already spent on personal SaaS plus team SaaS plus virtual EA service.

**Year 2 expansion:** US, UK, Singapore SaaS founders. Same persona profile.

**Distribution channels (priority order for year 1):**
1. Twitter build-in-public — primary, daily cadence
2. SaaSBoomi Slack + IndieHackers India — warm communities
3. Founder-to-founder referrals — slow-burn killer channel
4. ProductHunt launches (time to v2 readiness)
5. Newsletter sponsorships (Lenny's, Aakash Gupta, Wes Kao) — fund from v3 revenue
6. Founder podcast tour (year 2)
7. Cold email to seed/Series A founders — manual, high-conversion

---

## Stack Architecture

- **Frontend:** Next.js + Vercel
- **Backend:** Convex (Pro plan from v2+ at ~$25/month)
- **Auth:** Clerk (OAuth + JWT)
- **LLM:** Vercel AI SDK with provider abstraction
  - Gemini Flash-Lite for classification (cheap, fast)
  - Claude Sonnet for draft replies (voice quality matters more)
  - Hybrid model strategy from v1+
- **Analytics:** PostHog
- **Email:** Resend (transactional)
- **Payments:** UPI direct integration (forked from GlowUp.room pattern)
- **Vector embeddings (v2+):** Voyage or Cohere via Convex vector index

---

## Locked Strategic Decisions

- 6-version commitment from day 1
- Standalone product, not a feature inside something else
- B2C/prosumer SaaS at ₹2,499-9,999/month range
- India-first GTM, global expansion year 2
- ICP: cognitive-overloaded founders/CEOs/operators, not teams or enterprises initially
- Hero positioning: "second brain that runs your operating cadence while you sleep"
- Day 1 wedge: Gmail inbox triage + draft replies (v0 weekender slice)

---

## Open Strategic Questions to Revisit

Three places worth rethinking given v0 build learnings:

### 1. Wedge ordering

v0 is Gmail inbox triage. Building it surfaced heavy data scaling concerns (Convex bandwidth, Gemini quota limits). Consider: should v0 actually be voice-to-OKR (smaller data footprint, more demonstrable to non-technical founders)? Inbox triage moves to v1+ once architecture is hardened.

### 2. Module priority

Module 4 (Planning) might deserve to come ahead of Module 2 (Triage). Weekly plan generation is something founders measure value from immediately. Inbox triage requires a week of usage before time savings feel real. Quicker proof-of-value matters for paid SaaS conversion.

### 3. Module 5 (Memory) timing

The Memory module is the compound moat but it's deep in the roadmap (v2+). If a competitor lands on the same wedge in months 1-2, lacking memory means they could leapfrog. Consider: is there a "memory-light" feature in v1 to plant the moat earlier?

---

## Document maintenance

Update this document quarterly with:
- Actual paying user count vs target
- Learnings from each version
- Feature scope changes
- Pricing updates
- Distribution channel performance

Last updated: May 2, 2026 (Day 3 of v0 build).
