# Mental Health Surface — UI Specification

**Status:** Locked 2026-06-08, after 8-question spec session with Ajit.
**Scope:** v0 — Wingman's mental health layer, synthesizing public frameworks from Mochary Method, Tony Robbins, and Byron Katie's The Work.
**Brand note:** Per `ROADMAP.md` v6 entry: "Mental health + emotion tracking using public frameworks (NOT Mochary-branded for legal reasons)." Use the methodologies; never surface framework brand names inside Wingman UI.
**Schema source of truth:** `supabase/migrations/0012_mh_tables_and_assessment_state.sql`. The schema sketch later in this doc (around the "Data model" section) is illustrative shape only — actual DDL syntax, constraints, RLS policies, and indexes are in the migration file. Don't copy from the sketch.

---

## User-state matrix (locked 2026-06-08 18:45 UTC)

Six possible user states. Every MH feature must behave correctly in all six.

| State | Description | MH behavior |
|---|---|---|
| A | `mh_style` set (operational / state / inquiry) | Full framework content for that style — canonical path |
| B | `mh_style` null, fresh user, no skip recorded | Banner on `/dashboard`; `/daily` redirects to `/assessment` |
| C | `mh_style` null, skipped once (within 24h cooldown) | **Mixed mode** — all MH features render with balanced framework blend |
| D | `mh_style` null, skipped twice (permanent skip) | **Mixed mode** — same as C |
| E | `mh_style` set, wants to change | `/assessment` URL works from anywhere → re-take, overwrite `mh_style` |
| F | `mh_style` was set then deleted (e.g. via future Settings) | Treat as state B |

### Mixed mode (states C, D)

When a user has signaled they don't want to take the formal assessment but is still engaging with the product, render the safe-and-useful default for each MH surface rather than hiding MH entirely. Mixed mode is what makes the trial cohort experience the MH product even if they bounce off the 90-second assessment.

**Daily ritual in Mixed mode:**
- Morning (~3-4 min): 3 MIPs (Mochary) + 1 priming question (Robbins-style: "What state do I need to be in today?")
- Evening (~3-4 min): 1-10 score on the day + "Any stressful thought?" (Katie-lite, single field; offer 4Qs inline if a thought is entered) + "Did your state shift?" (Robbins-lite, one sentence)
- Persists to `mh_sessions` with `framework_used = 'mixed'`

**Contextual nudges in Mixed mode:**
- Only the **widget** pattern (passive). NO modal. NO observation.
- Neutral, framework-agnostic language ("Heavy week, want to take a breath?")
- Frequency cap unchanged (max 1/4h)

**On-demand "Help me think" in Mixed mode:**
- Same triage-first flow as canonical path
- Each route still picks the most universal framework move for that situation (decision → OPA, thought → Katie inquiry, drained → energy audit, other → open chat)
- No style-based defaults required

### Re-take flow (state E)

`/assessment` page must work for any `mh_style` value (null OR already-set). On Submit, write the new `mh_style` — overwrite is correct. NO confirmation prompt for v0 (users would expect re-take to just work). If we discover bookmark-by-accident issues during trial, add a "Re-taking will replace your current style — continue?" prompt in v1.

---

## Architecture overview

Three entry points sharing one data layer and one safety system. Each entry point inherits the user's onboarding-assessed framework style. The user has explicit control over data storage depth.

1. **Daily ritual surface** (morning + evening, dedicated destination)
2. **Contextual nudges** (woven into inbox, decisions, calendar surfaces)
3. **On-demand "Help me think"** (persistent button, triage-first flow)

Plus: **Onboarding framework-matching assessment** (5-6 forced-choice questions) that runs once after first Gmail sync, drives style across all three entry points, skippable with 24h re-nudge.

Plus: **Safety boundary system** that hard-refuses clinical/diagnostic/crisis-intervention requests and warm-hands-off to vetted regional resources.

---

## Entry point 1: Daily ritual surface

A dedicated `/daily` route. Two cards: Morning + Evening. Content shape depends on user's framework style (Operational / State / Inquiry, derived from onboarding assessment).

### Morning ritual (3-7 min depending on style)

**If Operational style (Mochary-derived):**
- Pick today's 3 MIPs (Most Important Problems). Free text, 3 fields.
- Rate each as Red / Yellow / Green energy.
- State 1 intention: "What state do I need to be in today?"

**If State style (Robbins-derived):**
- 3 gratitudes (1 sentence each).
- 1 priming question: "What's possible today that wasn't yesterday?"
- Pick today's primary focus + meaning: "What does today mean for me?"

**If Inquiry style (Katie-derived):**
- Single question: "What thought is most stressful right now?"
- If a thought is entered → run the 4 questions of The Work inline:
  - "Is it true?"
  - "Can you absolutely know it's true?"
  - "How do you react when you believe that thought?"
  - "Who would you be without it?"
- Plus one turnaround prompt: "What's the opposite of that thought? Is it as true or truer?"

### Evening ritual (5-7 min, hybrid)

Regardless of style, evening surface includes:
- Quick score on today (1-10 across: energy, focus, mood).
- Style-specific reflection:
  - Operational → "Score your 3 MIPs from this morning."
  - State → "Where did your state slip? What pulled you out?"
  - Inquiry → "What stressful thought arose today that you haven't questioned?"
- Open optional field: "Anything else?"

### Build notes
- Single React component with style prop. ~2-3 days for all 3 variants + persistence + the 4Qs inline form.
- All inputs respect the storage-level setting (see Data model below).
- Streak counter visible in the corner: "12 days." No shame for breaks.

---

## Entry point 2: Contextual nudges

Wingman observes triggers and surfaces nudges inside other Wingman surfaces (inbox, decision log, calendar). Three nudge UX patterns layered, with intensity governed by user's framework style.

### Trigger inventory
- **Email-based:** urgent bucket overflow (>X urgents in 24h), classification flags an angry-tone email, late-night activity pattern.
- **Decision-based:** about to log a decision, premortem/postmortem time.
- **Calendar-based:** heavy meeting day (>6 meetings), after long meeting (>90 min), before challenging meeting (flagged via keyword or counterparty).
- **Behavioral:** missed daily ritual for 3+ days, sudden activity burst after dormancy.

### Nudge patterns (all three layered)
- **Observation (subtle):** italic text near trigger event, tappable to expand.
  Example: *"You've marked 8 emails Urgent this week. Want to take 60 seconds with this?"*
- **Modal (heavy):** interrupts action with a 3-button card.
  Example: *"You're about to reply to a charged thread. 30 seconds to check first?"* Buttons: Run inquiry / State check / Skip and draft.
- **Widget (passive):** persistent dashboard card with weekly summary.
  Example: *"Your urgent bucket this week is 30% above your monthly average."*

### Style-based intensity
- **Operational founder:** mostly widget. Modals only for hard triggers (charged-email reply, decision log entry). Observation nudges rare.
- **State founder:** widget + observation + modals for state-sensitive moments (charged emails, late-night activity, post-heavy-meeting).
- **Inquiry founder:** widget + observation always-on. Modals offer inquiry-on-thought as the primary action.

### Frequency cap (mandatory)
- Max 1 modal per 4 hours of active session.
- Max 3 observation nudges per dashboard load.
- Widget refreshes once per day at first dashboard view.

### Build notes
- Trigger detection runs on the existing cron infrastructure. Most expensive: angry-email detection (requires LLM classification on each email body during ingest). Defer to v1 if budget tight; ship without that trigger.
- ~2-3 days build for all three nudge patterns + intensity router + frequency cap logic.

---

## Entry point 3: On-demand "Help me think"

Persistent button in the dashboard top-right (next to "Refresh inbox"). Triage-first flow.

### Flow

1. Founder clicks "Help me think."
2. Modal opens with 4 buttons:
   - "I'm stuck on a decision"
   - "I'm carrying a stressful thought"
   - "I'm drained or can't focus"
   - "Something else"
3. Each button routes to the matching framework:
   - **Decision** → Robbins-style OPA (Outcome, Purpose, Action) flow. 3 guided text fields, then summary.
   - **Stressful thought** → Byron Katie's 4 questions + 1 turnaround on the text the founder enters.
   - **Drained** → Mochary energy audit. List current week's tasks, score each R/Y/G, identify the top 2 yellow/red to address.
   - **Something else** → opens free-form chat with Wingman in coaching mode. LLM picks framework moves contextually.

### Session persistence
- Every session saved with timestamp + framework used + (per storage settings) the content.
- Referenced by daily ritual evening reflection: "You ran inquiry today at 2 PM. How did that land?"

### Build notes
- ~2-3 days build for triage modal + 3 framework templates + chat fallback.
- Chat fallback uses Gemini 2.5 Flash with a coaching-mode system prompt and the user's style preference.

---

## Onboarding framework-matching assessment

Runs once after first Gmail sync completes. Skippable. 24h follow-up nudge if skipped (once only).

### Question design: tightened forced-choice ranking, 5-6 questions

Each question presents 3 options. Founder ranks them 1-2-3 (most-like-me to least-like-me). Indirect wording so users can't easily reverse-engineer scoring.

**Q1: "After a tough meeting, my impulse is to..."**
- Open a list of next actions and start working through them.
- Take a walk or change environment to reset.
- Write down what I noticed about my own reactions.

**Q2: "The kind of advice I find most useful sounds like..."**
- "Here are the specific things to try this week."
- "Notice how your body and language are creating this."
- "What are you assuming that might not be true?"

**Q3: "When I'm spiraling on a problem, what usually breaks the loop is..."**
- Making the problem smaller — break it into parts.
- Doing something physical that changes my state.
- Asking 'is this actually true?' about whatever I'm telling myself.

**Q4: "I keep returning to a reflection practice when it..."**
- Helps me execute better the next day.
- Helps me feel better and more grounded.
- Helps me see something about myself I couldn't see before.

**Q5: "Late at night, the thoughts that keep me up are usually..."**
- Things I haven't done that I needed to do.
- Worries about how I came across or what's going to happen.
- Questions about whether I'm building the right thing or being the right person.

**Q6: "What does 'taking care of myself' mean to me right now?"**
- Getting organized and not letting things slip.
- Managing my energy — sleep, exercise, time off.
- Understanding why I keep doing the things I do.

### Scoring
- Each option maps to a framework (A → Operational, B → State, C → Inquiry).
- Forced ranking: most-like-me = 3 points, middle = 2, least = 1. Sum across 6 questions per framework. Highest sum wins.
- Ties broken by Q4 + Q6 (the most product-defining questions).
- Result stored as `users.mh_style` enum: `operational` | `state` | `inquiry`.

### Behavior
- Result drives: daily ritual content, contextual nudge tone, "Help me think" defaults.
- Founder can change anytime: Settings → MH style → re-run assessment OR direct toggle.
- Skip: 24h later, soft nudge surfaces ("Want to personalize your daily ritual? 90 seconds.") Skippable a second time, then never asks again.

### Build notes
- Assessment UI: ~1 day.
- Scoring logic + storage: ~30 min.
- 24h nudge cron: ~1 hour.
- Settings page entry: ~30 min.
- Total: ~1.5 days.

---

## Data model: 4-tier storage with user toggle

Founder controls what Wingman stores from MH sessions. Default at signup: **Aggregates** (middle tier).

### Tiers

**Tier 1: Minimum**
- Stores: `mh_style`, ritual timestamps, on-demand session timestamps, framework chosen per session.
- Does NOT store: any scores, any text content.
- Enables: streak counter, basic engagement metrics.

**Tier 2: Aggregates (default)**
- Stores: Tier 1 + numeric scores (energy 1-10, mood quadrant, MIP completion rate), nudge engagement (dismissed vs acted).
- Does NOT store: free text (no thoughts, no MIP descriptions, no journal entries).
- Enables: trend charts, basic pattern detection, simple nudge personalization.

**Tier 3: Text history**
- Stores: Tier 2 + full text of stressful thoughts logged, Katie inquiry responses, MIP descriptions, OPA responses, journal entries.
- Enables: longitudinal reference ("you logged this thought 3 weeks ago"), session-to-session continuity.

**Tier 4: Full correlation engine**
- Stores: Tier 3 + correlations computed between MH data and email patterns + calendar events + classification accuracy + draft tone.
- Enables: "You make better Important-bucket calls on days you logged green energy" insights.
- Note: correlations need ~30 days of data to be meaningful. Founders on Tier 4 see "Insights coming soon" for the first month.

### Schema sketch
```sql
alter type users add column mh_style text check (mh_style in ('operational', 'state', 'inquiry'));
alter type users add column mh_storage_tier int not null default 2 check (mh_storage_tier between 1 and 4);

create table mh_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users on delete cascade,
  type text check (type in ('morning_ritual', 'evening_ritual', 'on_demand', 'nudge_engaged')),
  framework_used text check (framework_used in ('operational', 'state', 'inquiry', 'mixed')),
  numeric_data jsonb, -- always populated for tier >= 2
  text_data jsonb,    -- nullable, only populated for tier >= 3
  created_at timestamptz not null default now()
);

create table mh_correlations (
  -- populated only for tier 4 users, computed nightly
  user_id uuid references users on delete cascade,
  correlation_type text,
  correlation_strength numeric,
  details jsonb,
  computed_at timestamptz
);
```

### Settings UI
- "Privacy → Mental health data" section.
- 4-tier picker with plain-language descriptions of what each stores.
- Downgrade behavior: when user downgrades from Tier 3→2 or 4→3, existing higher-tier data is deleted (with confirmation: "This will permanently delete X past entries").
- Upgrade behavior: takes effect immediately, no backfill of past sessions.

### Build notes
- Schema migration: ~30 min.
- Storage-level gating throughout MH write paths: ~1 day (touches every save in the MH stack).
- Settings UI + downgrade confirmation + delete logic: ~1 day.
- Correlation engine (Tier 4 only): ~2-3 days.
- Total: ~4-5 days for the full data layer.

---

## Safety boundary system

Hard refusal + warm handoff to vetted regional crisis resources. No personal contact name in v0 (deferred to v1 based on trial feedback).

### Detection
- LLM system prompt on every MH-surface call includes explicit refusal directives.
- Crisis content triggers: explicit ideation language, severe symptoms, abuse situations, requests for diagnosis or medication advice.
- On trigger: skip framework response, output the escalation script.

### Escalation script template
```
This is bigger than what I'm built for. Please reach out to a professional right now:

[REGION-SPECIFIC RESOURCES]

I'll be here when you're ready.
```

### Regional resources (initial set)
- **India:** iCall (9152987821, M-Sat 8am-10pm), Vandrevala Foundation (1860-2662-345, 24/7).
- **US:** 988 Suicide & Crisis Lifeline.
- **UK:** Samaritans (116 123).
- **EU + others:** International Association for Suicide Prevention directory link.

Region detection from user's Clerk profile (timezone or stated country). Default to India if unclear.

### Logging
- Log count + timestamp + region detected. NEVER log content.
- Surfaces in admin dashboard for monitoring frequency.
- If a user triggers > N escalations in a week, soft proactive nudge to dashboard: "Wingman noticed you've been carrying heavy weeks. We're not built for this kind of support — please consider talking to a professional. Here are the resources again."

### Build notes
- System prompt + refusal logic: ~2 hours.
- Regional detection + resource lookup: ~3 hours.
- Logging infrastructure: ~1 hour.
- Admin dashboard surface: ~2 hours.
- Total: ~1 day.

---

## Integration points with other v0 features

- **Onboarding (item 11):** Assessment runs after Gmail sync completes, before the first dashboard view.
- **Classification (item 2):** Angry-tone email detection adds a new classification side-channel that feeds the nudge trigger system.
- **Draft replies (item 3):** Before drafting a reply to an angry-tone email, the modal nudge fires (per intensity rules).
- **Voice corpus (item 7):** Voice corpus segments could include a "high-stress" segment if the founder draft-replies during a red-energy day. Stretch goal, defer to v1.
- **Decision log (items 35, 36):** Premortem/postmortem entries include a state check field (auto-populated from most recent ritual entry).
- **Personal CRM (item 21):** When founder logs a relationship interaction, optionally tag emotional state. Useful for the "you haven't talked to X in 6 weeks AND your last interaction was red-energy" combined nudge.
- **Calendar protection (item 31):** Deep-work block placement respects high-energy windows from MH data (Tier 2+ users).

---

## Total engineering estimate

| Component | Vibe-coded days |
|---|---|
| Onboarding assessment + scoring + 24h nudge | 1.5 |
| Daily ritual surface (3 style variants) | 2-3 |
| Contextual nudges (3 patterns + intensity router + frequency cap) | 2-3 |
| On-demand "Help me think" (triage + 3 framework templates + chat fallback) | 2-3 |
| Data model + 4-tier storage gating + settings UI | 2-3 |
| Correlation engine (Tier 4 only) | 2-3 |
| Safety boundary system + regional resources + admin logging | 1 |
| Integration wiring across 7 features | 1-2 |
| **TOTAL** | **13-18 vibe-coded days** |

This is the MH stack alone, in a 14-day window that also contains the other 24 v0 items.

---

## Open decisions deferred

1. **Voice input for daily ritual.** Could speed up morning ritual (voice memo → transcribed). Not in v0 scope.
2. **Mobile-optimized surfaces.** Spec assumes desktop dashboard. Mobile is post-trial.
3. **Multi-user nuances for v5.** When team seats arrive, MH data NEVER shares across seats. Make sure the schema enforces user_id isolation.
4. **Therapeutic disclaimer placement.** A small "Wingman is a coaching tool, not therapy" footer on MH surfaces — decided yes but exact wording TBD.
5. **Trusted contact opt-in.** Deferred to v1 per Q8 decision. May surface as a soft nudge after the trial cohort reports actual use patterns.
