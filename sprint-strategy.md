# Project Wingman — Path B Sprint Strategy Doc

Living document. Three sections. Work through in order — strategy informs UX informs eval. Last updated: May 11, 2026 (Day 1 evening).

---

## Section 1 — The Wingman Vision

**Purpose of this section:** A 1-2 page articulation of what Wingman becomes over 12-24 months. Written in first person, founder voice. This is the North Star document we derive launch positioning, landing copy, DM templates, and Twitter narrative from later — not a 1-liner yet. The 1-liner work happens in Week 7, once v1 features are in users' hands and the vision is grounded in evidence.

---

### Vision narrative — first draft (edit in your own voice)

I'm building Wingman because I've watched too many founders — including myself — drown in the cognitive load of running a company.

The pain doesn't sit in any one place. It's the email triage that takes ninety minutes a morning. It's the Slack messages you scroll past because you can't context-switch one more time. It's the calendar you stopped looking at three days ago. It's the investor follow-up you meant to send last Wednesday. It's the team direct report you haven't checked in on in two weeks. It's the energy you can't quite explain — why some weeks feel sharp and decisive, and others feel like wading through fog. It's the decision you made six months ago whose reasoning you can't quite remember. It's the customer feedback that came in over Slack and Twitter and email and never got assembled into anything actionable.

The standard answer is to hire an Executive Assistant or a Chief of Staff. An EA can only do so much; a CoS costs ₹40-80 lakh a year and most founders don't have that budget. And even when you have one, they can't do the thing that actually matters most — be a second brain that *learns who you are*.

Wingman is what I'd want if I could have a Chief of Staff who never sleeps, never forgets, and gets better at being mine every week. It reads everything coming into my workspace — email, Slack, calendar, project tools, analytics dashboards — and surfaces only the ten percent that demands my attention. It drafts the routine responses in my voice — not generic templates, but my actual writing pattern, learned across different relationships and contexts. It runs my operating cadence: my weekly priorities, my monthly reflection prompts, my quarterly OKRs, my investor cadence, my team check-ins. It builds a memory layer that compounds — every meeting, every email, every Slack DM, every decision I've made — queryable, surfaced contextually, used to make me sharper over time.

And — because cognitive overload is also an emotional and physical load — Wingman watches my energy. Not in a creepy way. In a *"you've slept five hours three nights in a row and your decisions are getting more impulsive, want to talk about what's on your mind?"* way. It correlates patterns in how I work with patterns in how I feel. Eventually, it notices when I'm slipping into a state I can't see myself. This part is the deepest and most personal layer of the product, and it ships only if the founders using Wingman explicitly ask for it. But it's part of the long arc.

The wedge — what Wingman does on Day 1 of a new user — is Gmail inbox triage plus draft replies in voice. That's the smallest, sharpest, most demonstrably-valuable thing it can do. But it's never just an inbox tool. The inbox is where it earns trust. Once it's read five hundred of my emails and learned my voice on a Tuesday morning, it's earned the right to read my Slack on a Thursday, my calendar on a Friday, my OKR doc on a Saturday. Each layer compounds. Each one makes the next one possible.

This is a 12-24 month build, not a feature. The first six weeks get to v1 — Gmail and Slack ingestion, voice-segmented drafting, calendar reading, and weekly plan generation. The next three months add Notion ingestion, multi-source triage, personal CRM, voice→OKR generation, and the early stakeholder cadence layer. The six months after that add competitive intelligence, decision logs with pre-mortem and post-mortem prompts, hiring pipeline tracking, reading synthesis, and team-mood monitoring for founders managing direct reports. The wellness/energy layer — the deepest, most personal, and most carefully-conditional part of the system — comes in year two if user demand demands it.

Pricing reflects the depth. ₹2,499/month for Solo Founder, which covers the v1 and v2 features. ₹4,999/month for Founder Plus, which adds the stakeholder communication layer. ₹9,999/month for Founder Premium, which adds the decision and knowledge memory layer plus one EA seat for shared context. International pricing in year two: $30 / $60 / $120. The first hundred paying users lock at their original price for life. India-first launch. Global expansion year two.

The bet is this: founders will pay non-trivial money for an AI that knows them better than any human assistant could, because the value isn't speed — it's compound clarity. And once a founder has handed two months of their workspace to Wingman, switching to a competitor means losing two months of accumulated context. The moat isn't the algorithm — it's the relationship.

The first ten founders to join are co-builders, not customers. They'll shape what gets built in v1, v2, v3. They'll catch me when I'm wrong about what matters. They'll have pricing locked for life as thanks.

That's what I'm building.

---

**Your reaction here:**

> _Where does this narrative feel right? Where does it feel forced or untrue to your actual motivation? The wellness/energy paragraph is the most speculative — does it belong this prominently in the vision, or as a footnote? Push back on the price-anchoring (₹2,499-9,999) — is that still the right number, or do you want to think harder about it given the broader scope? Edit until the whole thing reads like you wrote it. We'll use this as the source for launch copy in Week 7._

---

### Why we're not writing a 1-liner today

Three reasons.

First — the 1-liner work depends on knowing what v1 actually feels like in users' hands. We won't know until the friends-only trial at end of Week 3 (~June 15). Writing the 1-liner now and editing it later means anchoring on stale assumptions.

Second — every great founder positioning emerges from real user language, not whiteboard work. Stripe's "payments infrastructure for the internet" wasn't on a whiteboard in 2010; it came after watching hundreds of developers describe what they used Stripe for. We'll do the same — capture the language the trial founders use to describe Wingman to *their* founder friends, and derive the 1-liner from that.

Third — we have six weeks to build. Spending two of those days perfecting a 1-liner that will get rewritten in Week 7 is the wrong tradeoff right now.

The vision narrative above is the thing we *do* need today. It anchors the build, sets expectations with co-builders, and gives us source material to derive launch copy from later.

---

## Section 2 — Onboarding Flow Design

**Goal:** the first 60 seconds turn a curious founder into an engaged user. Map the journey, find friction, hand spec to Tab 1 tomorrow.

### Current state (mapped from what I observed in your dashboard)

1. **DM received** with link → founder clicks
2. **Landing page loads** → currently says: *"Project Wingman. AI Chief of Staff for founders. Coming soon."* + Sign in button
3. **Click Sign in** → Clerk modal opens → Google OAuth
4. **OAuth scope grant** → Gmail read + send permissions requested
5. **Redirect back** → Convex syncs ~30 days of email (30 sec - 2 min depending on inbox size)
6. **First dashboard view** → 1000+ emails classified into buckets

### Friction points I see (rank by severity)

**Severity HIGH:**

🔴 **Landing page says "Coming soon."** A paying user clicks an invite link from their friend and lands on a "coming soon" page. That kills credibility instantly. Must update before launch.

🔴 **OAuth scope ask is intimidating.** Gmail read + send is broad. Without explanation, users will hesitate or close. Need a 1-line *why* on the OAuth screen or just before it.

🔴 **First dashboard has no "what do I do?" moment.** User sees 1000 emails classified. So what? They need a clear "Try this one" CTA on the highest-value action — generating their first draft reply.

**Severity MEDIUM:**

🟡 **Sync wait (30 sec - 2 min) with no progress UI.** Currently shows "Refreshing... Connecting to your inbox..." but no count, no ETA, no transparency. Anxious 90 seconds = users tab-switch and forget.

🟡 **No empty state messaging if Urgent bucket is 0.** If the classifier returns 0 Urgent (like your dashboard often does), the user sees an empty bucket and thinks the product is broken. Need: "0 urgent emails right now. Looking good." or similar reassuring copy.

**Severity LOW:**

🟢 **No tour or feature explainer.** Acceptable for soft launch — founders are technical, they'll poke around.

🟢 **No personalization (welcome name, etc.).** "Welcome, ajit" already works. Fine.

### My recommended onboarding spec (hand to Tab 1)

1. **Landing copy** *(update before May 14)*:

> **Headline:** "An AI Chief of Staff. For founders who run too many things at once."
> **Sub:** "Wingman reads every email you receive, classifies what matters, and drafts replies in your voice. Started as my own daily tool — opening it up to a small group of founders."
> **CTA:** "Get access" (button) → Clerk sign in

2. **OAuth scope rationale** (shown above the Google OAuth button via Clerk's customizable modal, or on a one-line interstitial page):

> "Wingman needs to read your Gmail to classify it, and send replies you approve. We never store your password — Google handles auth directly. Nothing is shared with anyone."

3. **Sync progress UI**:

> "Reading your last 30 days of email..."
> [progress bar with live count: "127 / 1210 emails ingested..."]
> *(estimated 30-90 seconds for typical inboxes)*

4. **First dashboard with onboarding state**:

When the user has 0 emails opened/drafted, show a "Get started" banner pinned at top:

> 👋 "Welcome, ajit. We've classified your inbox. Try generating your first draft reply — click any Urgent or Important email below."
> [Dismiss banner once user opens 1 email]

5. **Empty-bucket copy** for Urgent = 0:

> "0 urgent emails right now. Looking calm — enjoy the breather."

**Your reaction here:**

> _What did I miss? Anything in here you'd cut? Friction point I named incorrectly? Once you finalize this section, paste it into Tab 1 as the spec for Day 9 (polish day)._

---

## Section 3 — Eval Set Extension (50 emails)

**Current: 20 emails across 4 buckets.** Goal: 30 more covering edge cases the current eval set misses.

### Edge case categories (4-5 examples per category)

**Category A — Customer emails (you have a paying user, they email you)**

Examples to add:
- Bug report from paying user → Should be: **Important** (or Urgent if blocker)
- Feature request from paying user → Should be: **Important**
- Refund request → Should be: **Urgent**
- Casual thanks from happy user → Should be: **FYI**

You currently have 0 customers, so we'll create *hypothetical* examples for the prompt to learn from. Use names/scenarios that match your future Wingman ICP (founders).

**Category B — Investor / fundraise**

Examples to add:
- Investor introducing a portfolio CEO to you → **Important**
- Investor asking for a quarterly update → **Important**
- Cold investor inbound asking for a meeting → **Important** (or FYI if you're not raising)
- Demo Day invitation → **FYI**

**Category C — Time-bound auto-renew**

Examples to add:
- AWS / Vercel renewal notice 30 days out → **Important**
- SaaS subscription renewal (Notion, Linear) → **FYI** unless action needed
- Domain renewal in 7 days → **Urgent**
- Insurance renewal → **Important**

**Category D — Cold inbound (you don't know the sender)**

Examples to add:
- Sales pitch from a SaaS vendor → **Archive**
- Cold "want to introduce you to a candidate" → **Archive** unless you're hiring
- Press inquiry from a journalist → **Important** (founder PR signal)
- Job applicant cold-emailing you → **FYI** (or Important if active hiring)

**Category E — Mixed personal/work**

Examples to add:
- Family member emailing about an event → **Important** (personal triage)
- Doctor / health appointment confirmation → **Important**
- Bank/credit card statement → **Archive**
- Power/internet bill due → **Important** if unpaid, FYI if auto-pay

**Category F — Reply chains / CC'd**

Examples to add:
- Thread where YOU initiated and got a reply → **Important** (your outbound landed)
- Thread where you're CC'd, not the primary recipient → **FYI** (unless the thread escalates to needing you)
- Group thread where someone @-mentioned you → **Important**

**Category G — Calendar / meeting**

Examples to add:
- Meeting invite from a founder peer → **Important** (relationship signal)
- Meeting decline from someone you invited → **FYI**
- Meeting reschedule request → **Important** (you need to respond)
- Recurring meeting notice → **Archive** (no action needed)

### How to extend the eval set

Open your Wingman dashboard. Scroll through emails. For each category above, find 4-5 real (or hypothetical-based-on-pattern) examples. Use the same format as today's set:

```
Sender: [name/email]
Subject: [first 50 chars]
Expected bucket: [Urgent | Important | FYI | Archive]
Reason: [1 line]
```

If you don't have real examples for a category (e.g., no investor emails in your current inbox), write the pattern-based hypothetical — Tab 1 will use it to extend the few-shot examples.

**Your reaction here:**

> _Pick 5-6 of these you can realistically find examples for in your inbox today. The rest can come from your imagination + reading similar emails. Time-box this section to 30 min — don't perfectionism it._

---

## How to work this doc

1. Open this file in your editor (it's in your Wingman folder).
2. Work Section 1 first (strategy). Edit my drafts, react inline, lock in your 1-liner.
3. Ping me when Section 1 is done. We refine together, then I'll generate a polished version you can use in DMs.
4. Move to Section 2 (onboarding). Same flow.
5. Section 3 (eval set extension) last — mechanical, mental cooldown.

**End-of-today target:** Section 1 locked, Section 2 reviewed, Section 3 with at least 10 new examples.

This doc is reusable — we'll update it through the sprint and post-launch as positioning sharpens with user feedback.
