"use client";

import { useState } from "react";
import { SignInButton } from "@clerk/nextjs";
import { WingmanLogo } from "@/components/WingmanLogo";
import styles from "./page.module.css";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_COPY: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  company_required: "Company name is required.",
  response_required: "Tell me what's on your mind — even one line.",
  response_too_long: "Keep it under 500 characters.",
  rate_limited:
    "Something looked off with that submission. Try again in a moment.",
};

export default function LandingPage() {
  return (
    <>
      <nav className={styles.nav}>
        <div className={styles.container}>
          <div className={styles.navInner}>
            <div className={styles.brand}>
              <div className={styles.logoMark}>
                <WingmanLogo size={38} />
              </div>
              <div className={styles.wordmark}>
                Wing<span className={styles.accent}>man</span>
              </div>
            </div>
            <div className={styles.navLinks}>
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
              <a href="#tiers">Plans</a>
              <SignInButton mode="modal">
                <button type="button" className={styles.navSignin}>
                  Sign in
                </button>
              </SignInButton>
              <a href="#waitlist" className={styles.navCta}>
                Get access
              </a>
            </div>
          </div>
        </div>
      </nav>

      <section className={styles.hero}>
        <div className={styles.container}>
          <div className={styles.heroInner}>
            <div className={styles.heroBadge}>
              <span className={styles.badgeDot}></span>v1.0 · invite-only early
              access
            </div>
            <h1 className={styles.heroTitle}>
              Your AI <span className={styles.ital}>Chief of Staff.</span>
              <span className={styles.break}></span>Built to know{" "}
              <span className={styles.ital}>you</span>, not just your inbox.
            </h1>
            <p className={styles.heroSub}>
              Wingman reads everything across your workspace — email, Slack,
              calendar, documents, decisions. Surfaces only what matters. Drafts
              in your voice. Runs your operating cadence while you sleep.
            </p>
            <div className={styles.heroCtaRow}>
              <a href="#waitlist" className={styles.ctaPrimary}>
                Request founding access <span>→</span>
              </a>
              <a href="#how" className={styles.ctaSecondary}>
                See how it works
              </a>
            </div>

            <div className={styles.heroStats}>
              <div>
                <div className={styles.statNum}>90 min → 5 min</div>
                <div className={styles.statLabel}>Daily inbox triage</div>
              </div>
              <div>
                <div className={styles.statNum}>9 of 10</div>
                <div className={styles.statLabel}>Voice match on drafts</div>
              </div>
              <div>
                <div className={styles.statNum}>100</div>
                <div className={styles.statLabel}>Founding spots open</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.problem}>
        <div className={styles.container}>
          <div className={styles.editorialEyebrow}>The problem</div>
          <h2>
            Running a company shouldn&apos;t mean drowning in cognitive load.{" "}
            <span className={styles.ital}>But here we are.</span>
          </h2>

          <div className={styles.problemGrid}>
            <div className={styles.problemText}>
              <p>
                You wake up.{" "}
                <span className={styles.bold}>There are 87 unread emails</span>,
                12 Slack DMs, 4 calendar invites that conflict, an investor
                follow-up you meant to send last Wednesday, a customer thread
                that escalated overnight, and your team&apos;s quarterly OKR doc
                that needs your review by Friday.
              </p>
              <p>
                You spend ninety minutes triaging. You forget which investor you
                owe a follow-up to. You scroll past Slack messages because you
                can&apos;t context-switch one more time. You make a decision
                you&apos;ll forget the reasoning for in six months.
              </p>
              <p>
                <span className={styles.bold}>
                  The standard answer is to hire a Chief of Staff.
                </span>{" "}
                A CoS costs ₹40-80 lakh a year. An EA can only do so much. And
                neither of them can be a second brain that actually learns who
                you are.
              </p>
            </div>

            <div className={styles.dailyTax}>
              <div className={styles.taxLabel}>Your daily cognitive tax</div>
              <div className={styles.taxItem}>
                <span className={styles.taxTask}>Inbox triage + replies</span>
                <span className={styles.taxTime}>90 min</span>
              </div>
              <div className={styles.taxItem}>
                <span className={styles.taxTask}>
                  Slack catch-up across channels
                </span>
                <span className={styles.taxTime}>45 min</span>
              </div>
              <div className={styles.taxItem}>
                <span className={styles.taxTask}>
                  Calendar review + reschedules
                </span>
                <span className={styles.taxTime}>20 min</span>
              </div>
              <div className={styles.taxItem}>
                <span className={styles.taxTask}>
                  Investor + stakeholder follow-ups
                </span>
                <span className={styles.taxTime}>30 min</span>
              </div>
              <div className={styles.taxItem}>
                <span className={styles.taxTask}>
                  Team status + decision tracking
                </span>
                <span className={styles.taxTime}>35 min</span>
              </div>
              <div className={styles.taxTotal}>
                <span className={styles.taxTotalLabel}>Total per day</span>
                <span className={styles.taxTotalTime}>3.7 hours</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.osSection} id="how">
        <div className={styles.container}>
          <div className={styles.editorialEyebrow}>How it works</div>
          <h2>
            Wingman sits between your workspace and your attention —{" "}
            <span className={styles.ital}>
              a second brain that thinks for you.
            </span>
          </h2>
          <p className={styles.osSub}>
            Every signal coming in gets read, weighed, classified, drafted, or
            remembered. You stay in the loop on what matters. You stop seeing
            what doesn&apos;t.
          </p>

          <div className={styles.osDiagram}>
            <div className={styles.osColumn}>
              <h4>Reads from</h4>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Gmail
              </div>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Slack DMs + mentions
              </div>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Google Calendar
              </div>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Notion + Docs
              </div>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Sheets + Analytics
              </div>
              <div className={styles.osSource}>
                <span className={styles.osSourceDot}></span>Meeting transcripts
              </div>
            </div>

            <div className={styles.osCore}>
              <div className={styles.osCoreLogo}>
                <WingmanLogo size={56} color="#d99060" />
              </div>
              <div className={styles.osCoreName}>
                Wing<span className={styles.ital}>man</span>
              </div>
              <p className={styles.osCoreDesc}>
                Learns your voice, your relationships, your cadence, your
                decisions. Compounds every week.
              </p>
            </div>

            <div className={styles.osColumn}>
              <h4>Surfaces / drafts</h4>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>U</span>Urgent attention
                required
              </div>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>I</span>Important to
                review
              </div>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>D</span>Drafted replies in
                your voice
              </div>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>P</span>Plans + OKRs +
                cadence
              </div>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>M</span>Memory queryable
                anytime
              </div>
              <div className={styles.osOutput}>
                <span className={styles.osOutputIcon}>E</span>Energy + state
                insights
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.features} id="features">
        <div className={styles.container}>
          <div className={styles.editorialEyebrow}>What Wingman does</div>
          <h2>
            Eleven operating systems.{" "}
            <span className={styles.ital}>One second brain.</span> Built to
            compound.
          </h2>
          <p className={styles.featuresSub}>
            Most &quot;AI for founders&quot; tools handle one thing. Wingman is
            built as the layer everything else lives on top of — so the value
            grows every week you use it.
          </p>

          <div className={styles.bento}>
            <div className={`${styles.bentoCard} ${styles.lg}`}>
              <div className={styles.bcEyebrow}>Intelligent triage</div>
              <h3>Reads everything. Surfaces 10%.</h3>
              <p>
                Every email, Slack DM, and calendar item classified into Urgent,
                Important, FYI, or Archive. Spam, marketing, and noise filtered
                out of your view. Ninety minutes of triage becomes a five-minute
                review.
              </p>
              <div className={styles.bcVisual}>
                <div className={styles.emailDemo}>
                  <div className={styles.emailRow}>
                    <span className={`${styles.emailTag} ${styles.tagUrgent}`}>
                      Urgent
                    </span>
                    <span>
                      Investor follow-up — needs response by Thursday
                    </span>
                  </div>
                  <div className={styles.emailRow}>
                    <span
                      className={`${styles.emailTag} ${styles.tagImportant}`}
                    >
                      Important
                    </span>
                    <span>Customer feedback on v0.4 launch</span>
                  </div>
                  <div className={styles.emailRow}>
                    <span className={`${styles.emailTag} ${styles.tagFyi}`}>
                      Archive
                    </span>
                    <span>
                      LinkedIn job alerts · Uber receipts · marketing
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className={`${styles.bentoCard} ${styles.sm}`}>
              <div className={styles.bcEyebrow}>Voice match</div>
              <h3>Drafts in your voice. Across every relationship.</h3>
              <p>
                Investor voice differs from team voice differs from peer voice.
                Wingman knows the difference and segments accordingly.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>Multi-source ingestion</div>
              <h3>Reads your full workspace.</h3>
              <p>
                Not just inbox. Gmail, Slack DMs and mentions, Google Calendar,
                Notion pages, Sheets, analytics dashboards from PostHog and
                Mixpanel.
              </p>
              <div className={styles.bcVisual}>
                <div className={styles.connectorGrid}>
                  <div className={styles.connector}>Gmail</div>
                  <div className={styles.connector}>Slack</div>
                  <div className={styles.connector}>Calendar</div>
                  <div className={styles.connector}>Notion</div>
                  <div className={styles.connector}>Sheets</div>
                  <div className={styles.connector}>PostHog</div>
                  <div className={styles.connector}>Mixpanel</div>
                  <div className={styles.connector}>Linear</div>
                </div>
              </div>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>Operating cadence</div>
              <h3>Runs your weekly rhythm.</h3>
              <p>
                Weekly priorities, monthly reflection, quarterly OKRs. Generated
                proactively from your work signal. Never forgotten.
              </p>
              <div className={styles.bcVisual}>
                <div className={styles.cadenceList}>
                  <div className={styles.cadenceItem}>
                    <span className={styles.cadenceWhen}>Mon</span>
                    <span>
                      Weekly priorities drafted from last week&apos;s signal
                    </span>
                  </div>
                  <div className={styles.cadenceItem}>
                    <span className={styles.cadenceWhen}>Last Sun</span>
                    <span>Monthly reflection prompts</span>
                  </div>
                  <div className={styles.cadenceItem}>
                    <span className={styles.cadenceWhen}>Q-end</span>
                    <span>OKR draft pulled from operating data</span>
                  </div>
                </div>
              </div>
            </div>

            <div className={`${styles.bentoCard} ${styles.lg}`}>
              <div className={styles.bcEyebrow}>Personal CRM + memory</div>
              <h3>Knows everyone. Remembers everything.</h3>
              <p>
                Every meeting, email, Slack DM ingested and queryable by name or
                topic.{" "}
                <em>&quot;What did Maya last say about pricing?&quot;</em>{" "}
                Answered in seconds. The longer you run Wingman, the deeper this
                gets — your switching cost becomes the relationship itself.
              </p>
              <div className={styles.bcVisual}>
                <span className={styles.memoryChip}>Maya Rodriguez</span>
                <span className={styles.memoryChip}>Pricing discussions</span>
                <span className={`${styles.memoryChip} ${styles.active}`}>
                  Last 90 days
                </span>
                <span className={styles.memoryChip}>All sources</span>
                <span className={styles.memoryChip}>Decisions made</span>
              </div>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>Stakeholder cadence</div>
              <h3>Investors, board, customers — never silent.</h3>
              <p>
                Wingman notices when you haven&apos;t messaged Investor X in six
                weeks. Drafts the monthly investor update from your operating
                data. Watches the relationships that matter.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>Voice-to-OKR</div>
              <h3>Speak your priorities. Get a plan.</h3>
              <p>
                Record a two-minute voice memo on Sunday. Wingman extracts your
                weekly OKRs, breaks them into tasks, slots them against your
                calendar, and reminds you on Friday what slipped.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.sm}`}>
              <div className={styles.bcEyebrow}>Calendar intelligence</div>
              <h3>Protects your deep work.</h3>
              <p>
                Spots overload before you do. Reserves calendar blocks. Flags
                meetings that should have been emails.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.sm}`}>
              <div className={styles.bcEyebrow}>Decision memory</div>
              <h3>Never repeat a wrong call.</h3>
              <p>
                Pre-mortem and post-mortem prompts on every major decision.
                Searchable history of what you decided and why.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>
                Reading + learning synthesis
              </div>
              <h3>The articles you saved actually surface.</h3>
              <p>
                Highlighted articles, saved tweets, podcast notes ingested and
                contextually surfaced when relevant to a decision you&apos;re
                making or an email you&apos;re drafting.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.md}`}>
              <div className={styles.bcEyebrow}>Team intelligence</div>
              <h3>Direct reports, never neglected.</h3>
              <p>
                Cadence tracker for one-on-ones. Mood and energy signals from
                your direct reports surfaced before they become turnover risk.
              </p>
            </div>

            <div className={`${styles.bentoCard} ${styles.full}`}>
              <div className={styles.bcEyebrow}>Energy + wellness layer</div>
              <h3>Notices what you can&apos;t see in yourself.</h3>
              <p style={{ maxWidth: "720px" }}>
                When your sleep, exercise, calendar density, and decision-making
                patterns correlate with a state you&apos;d rather not be in —
                Wingman tells you.{" "}
                <em>
                  &quot;You&apos;ve slept five hours three nights in a row. Your
                  decisions in the last 48 hours have been more reactive than
                  usual. Want to talk about what&apos;s on your mind?&quot;
                </em>{" "}
                The deepest, most personal layer. Opt-in. Built carefully.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.compound}>
        <div className={styles.container}>
          <div className={styles.editorialEyebrow}>The compound moat</div>
          <h2>
            The longer you use Wingman,{" "}
            <span className={styles.ital}>the more it knows you.</span>
          </h2>
          <p className={styles.compoundSub}>
            Most software is most valuable on day one and decays from there.
            Wingman is the opposite — every week of use makes it harder to leave
            and more useful to keep.
          </p>

          <div className={styles.timeline}>
            <div className={styles.timelineItem}>
              <div className={styles.timelineWhen}>Day 1</div>
              <div className={styles.timelineWhat}>
                Inbox triaged. First draft generated.
              </div>
              <div className={styles.timelineImpact}>
                Time savings start immediately.
              </div>
            </div>
            <div className={styles.timelineItem}>
              <div className={styles.timelineWhen}>Week 4</div>
              <div className={styles.timelineWhat}>
                Voice is dialed across 4 relationship types.
              </div>
              <div className={styles.timelineImpact}>
                Drafts feel uncanny — like you wrote them.
              </div>
            </div>
            <div className={styles.timelineItem}>
              <div className={styles.timelineWhen}>Month 3</div>
              <div className={styles.timelineWhat}>
                Personal CRM covers your full network.
              </div>
              <div className={styles.timelineImpact}>
                Every relationship recallable in seconds.
              </div>
            </div>
            <div className={styles.timelineItem}>
              <div className={styles.timelineWhen}>Month 12</div>
              <div className={styles.timelineWhat}>
                Decision history + reading synthesis live.
              </div>
              <div className={styles.timelineImpact}>
                Switching cost: a year of your own context.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.tiers} id="tiers">
        <div className={styles.container}>
          <div className={styles.editorialEyebrow}>Plans</div>
          <h2>
            Three tiers, built for where you are.{" "}
            <span className={styles.ital}>All on annual commitment.</span>
          </h2>
          <p className={styles.tiersSub}>
            Founding 100 spots lock pricing for life. After launch, public
            pricing announced separately.
          </p>

          <div className={styles.tierGrid}>
            <div className={styles.tierCard}>
              <div className={styles.tierName}>Solo Founder</div>
              <div className={styles.tierHeadline}>
                For founders running their own operating cadence.
              </div>
              <p className={styles.tierDesc}>
                The full triage + voice-match + cadence system. Built for the
                founder doing it all.
              </p>
              <div className={styles.tierPriceSlot}>
                <span>Pricing announced at launch</span>
              </div>
              <ul className={styles.tierFeatures}>
                <li>Gmail + Slack + Calendar ingestion</li>
                <li>Intelligent triage across all sources</li>
                <li>Voice-matched drafting</li>
                <li>Weekly + monthly + quarterly cadence</li>
                <li>Voice-to-OKR generation</li>
                <li>Personal CRM (core)</li>
              </ul>
            </div>

            <div className={`${styles.tierCard} ${styles.featured}`}>
              <span className={styles.featuredLabel}>Most chosen</span>
              <div className={styles.tierName}>Founder Plus</div>
              <div className={styles.tierHeadline}>
                For founders managing stakeholders + a small team.
              </div>
              <p className={styles.tierDesc}>
                Everything in Solo Founder plus the stakeholder layer —
                investors, board, customers, direct reports.
              </p>
              <div className={styles.tierPriceSlot}>
                <span>Pricing announced at launch</span>
              </div>
              <ul className={styles.tierFeatures}>
                <li>Everything in Solo Founder</li>
                <li>Notion + Sheets + analytics ingestion</li>
                <li>Stakeholder cadence tracking</li>
                <li>Investor + board update auto-drafts</li>
                <li>Calendar intelligence + deep work protection</li>
                <li>Team mood + 1:1 cadence</li>
                <li>Decision logs with pre/post-mortem</li>
              </ul>
            </div>

            <div className={styles.tierCard}>
              <div className={styles.tierName}>Founder Premium</div>
              <div className={styles.tierHeadline}>
                For founders running multi-stakeholder operations.
              </div>
              <p className={styles.tierDesc}>
                Everything plus the deepest layers, EA seat, and opt-in wellness
                intelligence.
              </p>
              <div className={styles.tierPriceSlot}>
                <span>Pricing announced at launch</span>
              </div>
              <ul className={styles.tierFeatures}>
                <li>Everything in Founder Plus</li>
                <li>Reading + learning synthesis</li>
                <li>Hiring pipeline tracker</li>
                <li>Multi-user: 1 EA / CoS seat</li>
                <li>Public API + webhook access</li>
                <li>Energy + wellness layer (opt-in)</li>
                <li>Priority founder support</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.vision} id="vision">
        <div className={styles.container}>
          <div className={styles.visionInner}>
            <div className={styles.editorialEyebrow}>From the founder</div>
            <h2>
              I&apos;m not building an AI inbox tool.{" "}
              <span className={styles.ital}>
                I&apos;m building the operating system founders deserve.
              </span>
            </h2>
            <div className={styles.visionBody}>
              <p>
                I&apos;ve watched too many founders — including myself — drown
                in cognitive load while pretending to scale companies. The pain
                doesn&apos;t sit in any one place.{" "}
                <span className={styles.bold}>
                  It&apos;s in the hundred small things that don&apos;t fit into
                  one tool
                </span>{" "}
                — the inbox, the Slack catch-up, the calendar, the investor
                follow-up you forgot, the decision you can&apos;t remember the
                reasoning for, the energy you can&apos;t quite explain.
              </p>
              <p>
                The standard answer — hire a Chief of Staff — costs ₹40-80 lakh
                a year. Most founders can&apos;t afford one. And even when they
                can, no human can be a second brain that actually learns who you
                are.
              </p>
              <p>
                Wingman is what I&apos;d want if I could have a Chief of Staff
                who never sleeps, never forgets, and gets sharper at being mine
                every week.{" "}
                <span className={styles.bold}>
                  The wedge is your inbox — but the destination is your whole
                  operating life.
                </span>
              </p>
            </div>
            <div className={styles.visionSig}>
              — Ajit Nayak, creator of Wingman
            </div>
          </div>
        </div>
      </section>

      <section className={styles.waitlist} id="waitlist">
        <div className={styles.container}>
          <div className={styles.waitlistInner}>
            <div className={styles.editorialEyebrow}>Join the founding 100</div>
            <h2>
              The first hundred founders{" "}
              <span className={styles.ital}>shape what gets built next.</span>
            </h2>
            <p className={styles.waitlistSub}>
              Reading every application personally. Tell me what you&apos;re
              drowning in — I&apos;m building this with you, not for you.
            </p>

            <WaitlistForm />

            <p className={styles.foundingNote}>
              First 100 founders lock pricing for life. India-first launch.
              Global expansion to follow.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.faq}>
        <div className={styles.container}>
          <h2>Questions founders are asking.</h2>
          <div className={styles.faqGrid}>
            <div className={styles.faqItem}>
              <h4>How is this different from Superhuman or Sanebox?</h4>
              <p>
                Those manage your inbox. Wingman manages your operating cadence
                — and inbox is just where it starts. Voice match across
                relationship types, multi-source ingestion, personal CRM, and
                the cadence layer don&apos;t exist anywhere else.
              </p>
            </div>
            <div className={styles.faqItem}>
              <h4>What happens to my data?</h4>
              <p>
                Your data lives in your account. Read access used only to build
                your personal Wingman context. Not used to train any general
                model. Full export and deletion any time.
              </p>
            </div>
            <div className={styles.faqItem}>
              <h4>How does the voice match actually work?</h4>
              <p>
                Wingman reads your last 100 sent emails, segments them by
                relationship type (cold outreach, investor, internal team,
                peer), and uses the matching segment when drafting replies. So
                your investor voice stays distinct from your team voice.
              </p>
            </div>
            <div className={styles.faqItem}>
              <h4>Why &quot;founding 100&quot;?</h4>
              <p>
                You&apos;ll catch what I miss. Your feedback shapes v2, v3, v4.
                In exchange you lock at the original price for life, get direct
                line to me, and your name on the Wingman wall.
              </p>
            </div>
            <div className={styles.faqItem}>
              <h4>When do I get access?</h4>
              <p>
                Founding 100 invites roll out July onward, in cohorts of 10. We
                start with founders whose cognitive overload notes resonate most
                strongly with what Wingman solves today.
              </p>
            </div>
            <div className={styles.faqItem}>
              <h4>Is the wellness layer creepy?</h4>
              <p>
                Opt-in only, always. Built around correlations you already track
                (sleep, exercise, calendar density). Never shared. Designed to
                surface what you can&apos;t see in yourself — not to surveil
                you.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.container}>
          <div className={styles.footerTop}>
            <div className={styles.footerBrand}>
              <div
                className={styles.brand}
                style={{ marginBottom: "16px" }}
              >
                <div
                  className={styles.logoMark}
                  style={{ width: "32px", height: "32px" }}
                >
                  <WingmanLogo size={32} />
                </div>
                <div
                  className={styles.wordmark}
                  style={{ fontSize: "24px" }}
                >
                  Wing<span className={styles.accent}>man</span>
                </div>
              </div>
              <p>
                An AI Chief of Staff for founders. Built carefully, in public,
                with the first hundred users.
              </p>
            </div>
            <div className={styles.footerCol}>
              <h5>Product</h5>
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
              <a href="#tiers">Plans</a>
              <a href="#waitlist">Get access</a>
            </div>
            <div className={styles.footerCol}>
              <h5>Company</h5>
              <a href="#vision">Vision</a>
              <a href="#">Founder note</a>
              <a href="#">Build journal</a>
              <a href="mailto:ajit23nayak@gmail.com">Contact</a>
            </div>
            <div className={styles.footerCol}>
              <h5>Legal</h5>
              <a href="#">Privacy policy</a>
              <a href="#">Terms of service</a>
              <a href="#">Data + security</a>
            </div>
          </div>
          <div className={styles.footerBottom}>
            <div>© {new Date().getFullYear()} Wingman · All rights reserved</div>
            <div className={styles.built}>Built in Bangalore.</div>
          </div>
        </div>
      </footer>
    </>
  );
}

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [response, setResponse] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [formOpenedAt] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<
    "idle" | "success" | "success_duplicate" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg("");

    if (!EMAIL_REGEX.test(email.trim())) {
      setErrorMsg("Please enter a valid email address");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          company: company.trim(),
          overload_response: response.trim(),
          honeypot,
          formOpenedAt,
        }),
      });
      const result = await res.json();

      if (result.ok) {
        setSubmitState(result.duplicate ? "success_duplicate" : "success");
      } else {
        setErrorMsg(
          ERROR_COPY[result.error] ?? "Something went wrong. Please try again.",
        );
      }
    } catch {
      setErrorMsg("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitState === "success") {
    return (
      <div className={styles.waitlistSuccess}>
        <p>
          You&apos;re in the founding pool. I read every application personally
          — expect a note from me within 7 days.
        </p>
        <p className={styles.waitlistSig}>— Ajit Nayak, creator of Wingman</p>
      </div>
    );
  }

  if (submitState === "success_duplicate") {
    return (
      <div className={styles.waitlistSuccess}>
        <p>
          We already have your application — I read every one personally. Expect
          a note within 7 days.
        </p>
        <p className={styles.waitlistSig}>— Ajit Nayak</p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.formRow}>
        <label htmlFor="waitlist-email">Work email</label>
        <input
          id="waitlist-email"
          type="email"
          placeholder="you@yourcompany.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="waitlist-company">Company</label>
        <input
          id="waitlist-company"
          type="text"
          placeholder="Company name"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
        />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="waitlist-response">
          What&apos;s the cognitive overload that bothers you most right now?
        </label>
        <textarea
          id="waitlist-response"
          placeholder="One line is fine. Specific is better. I read every one."
          value={response}
          onChange={(e) => setResponse(e.target.value)}
          required
        />
      </div>

      {/* Honeypot: bots auto-fill fields named "website". Hidden visually
          + aria-hidden on the input so screen readers skip it entirely. */}
      <div className={styles.honeypot} aria-hidden="true">
        <input
          id="waitlist-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <button type="submit" className={styles.submitBtn} disabled={submitting}>
        {submitting ? "Sending…" : "Request founding access"}
      </button>
      {errorMsg && <p className={styles.formError}>{errorMsg}</p>}
    </form>
  );
}
