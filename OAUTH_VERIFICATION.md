# Google OAuth Verification Submission Package

**Goal:** verified OAuth status for Wingman by ~July 25, 2026.
**Why not blocking June 15 trial:** Google permits up to 100 unverified-app users for restricted Gmail scopes. Trial is 10 users, well under cap. Founders will click through the "Advanced → unsafe" warning.

This document contains everything you need to paste into Google Cloud Console → APIs & Services → OAuth consent screen.

---

## Step 1: Open the right console page

URL: https://console.cloud.google.com/apis/credentials/consent?project=gen-lang-client-0417020630

(Replace project ID if Wingman is on a different Google Cloud project.)

---

## Step 2: App information section

| Field | Value |
|---|---|
| **App name** | `Wingman` |
| **User support email** | `ajit23nayak@gmail.com` |
| **App logo** | Upload a 120x120 PNG logo (use the SVG from the landing page nav, exported to PNG). Optional but recommended — improves consent screen trust. |
| **App home page** | `https://project-wingman-pi.vercel.app` (replace with custom domain if you have one) |
| **App privacy policy link** | `https://project-wingman-pi.vercel.app/privacy` |
| **App terms of service link** | `https://project-wingman-pi.vercel.app/terms` (build this page too — see appendix below) |
| **Authorized domains** | `vercel.app` (add your custom domain if applicable, e.g. `wingman.app`) |
| **Developer contact information** | `ajit23nayak@gmail.com` |

---

## Step 3: Scopes section

Click **Add or Remove Scopes** and add these four:

### 3.1 Non-sensitive scopes (auto-approved)

- `.../auth/userinfo.email` — See your primary Google Account email address
- `.../auth/userinfo.profile` — See your personal info, including any personal info you've made publicly available
- `openid`

### 3.2 Sensitive/Restricted scopes (require verification)

- `https://www.googleapis.com/auth/gmail.readonly` — **RESTRICTED**: View your email messages and settings
- `https://www.googleapis.com/auth/gmail.send` — **SENSITIVE**: Send email on your behalf

Each restricted/sensitive scope needs a justification (Step 4 below).

---

## Step 4: Scope justifications (copy-paste exact text into the form)

### 4.1 Justification for `gmail.readonly`

```
Wingman is an AI Chief of Staff for founders. We read the user's Gmail inbox to provide three core features:

1. INBOX TRIAGE: We classify each incoming email into one of four buckets (Urgent, Important, FYI, Archive) so the user can focus only on what needs their attention. Without read access, classification is impossible.

2. VOICE LEARNING: We read the user's recently-sent emails to learn their writing voice. This is how Wingman generates draft replies that sound like the user, not like a generic AI assistant. We segment voice samples by relationship type (cold outreach, internal team, investor, peer) for higher fidelity.

3. CONTEXT-AWARE DRAFTING: When the user wants to reply to an incoming email, Wingman reads the full thread context to generate a relevant draft.

The user is in full control. Wingman never deletes emails, never modifies emails, and never marks emails as read. We only read.

Data retention: classifications and metadata are stored in our database (Supabase, Mumbai region, encrypted at rest, Row-Level Security enforced). Raw email content is fetched on demand and not retained beyond the API call. The user can request full data deletion at any time.
```

### 4.2 Justification for `gmail.send`

```
Wingman drafts replies in the user's voice. The user reviews each draft, edits if needed, and clicks "Send." When they click send, we use gmail.send to deliver the reply via the user's Gmail account.

This is essential to the product's core promise: "drafts what's routine in your voice." Without send capability, users would have to copy-paste every draft into Gmail manually, defeating the time-savings value proposition.

Important safeguards:
- We never send autonomously. Every send is triggered by an explicit user click.
- The draft is always editable before sending — we are not a "fully automated assistant."
- We do not send to recipients the user hasn't already communicated with (replies only, no cold sends initiated by Wingman).

Data handling: we use gmail.send only at the moment of user-confirmed reply. We do not store sent message bodies after delivery. We do retain a record that "user X replied to thread Y at time Z" for audit and dashboard purposes.
```

---

## Step 5: Test users (during verification)

While verification is pending, Google allows up to 100 users in "test users" mode. Add:

- `ajit23nayak@gmail.com` (you)
- Add the 10 founding-trial users by email as they sign up

Each test user must be added explicitly in the OAuth consent screen settings.

---

## Step 6: Submit for verification

After all sections are filled, click **Submit for verification** at the top of the OAuth consent screen page.

**What happens next:**

1. **Brand verification (1-2 weeks):** Google verifies app name + logo + ownership of the domain. Usually fast.
2. **Security assessment (2-4 weeks):** Google asks for proof of how you handle Gmail data securely. They will email asking for:
   - Demo video showing OAuth flow + the product reading + drafting + sending mail
   - Privacy policy review (already have at `/privacy`)
   - Confirmation that data isn't sold or used for advertising
   - Confirmation of secure storage practices (Supabase RLS, encrypted at rest)
3. **Optional independent security assessment (CASA Tier 2):** Required only if you have 100+ users for restricted scopes. Skip until you hit that.

**During verification window:** unverified-app warning persists on consent screen. Test users (those added in Step 5) can still authenticate by clicking "Advanced → Go to Wingman (unsafe)". This is acceptable for trial.

---

## Step 7: Submission checklist

Before clicking Submit, verify:

- [ ] Privacy policy page is publicly accessible at `/privacy` (deploy this in your next commit)
- [ ] Terms of service page is publicly accessible at `/terms` (build this — see appendix below)
- [ ] Application home page loads cleanly (the new landing page Tab 1 is shipping right now)
- [ ] App logo is a 120x120 PNG, well-cropped, recognizable
- [ ] Scope justifications above are pasted exactly
- [ ] Authorized domain matches your deployment URL
- [ ] Test users include your own email so you can verify the flow

---

## Appendix A: Demo video script

When Google asks for the demo video (will happen in security assessment), follow this script (45-60 seconds):

```
[Screen capture starts on Wingman landing page]

VOICEOVER: "This is Wingman. It's an AI Chief of Staff for founders."

[Click 'Get access' button → Clerk modal opens]

VOICEOVER: "When a new user signs up, they connect their Gmail via Google OAuth."

[Click Continue with Google → show OAuth consent screen with both scopes visible]

VOICEOVER: "They review the scopes — read Gmail to classify and learn voice, send Gmail to deliver approved replies — and grant access."

[Land on dashboard, show classified emails]

VOICEOVER: "Wingman immediately classifies the inbox and surfaces what matters. Urgent, Important, FYI, Archive."

[Click on an email → draft view]

VOICEOVER: "When the user wants to reply, Wingman drafts in their voice. They review, edit, then send."

[Click Send → email goes out]

VOICEOVER: "Send fires gmail.send. The user is always in control of every outbound message."

[End on dashboard with sent confirmation]

VOICEOVER: "That's Wingman. The user is the decision-maker. We're the operator."
```

Record this in OBS or Loom once Phase 3a + 3b are live.

---

## Appendix B: Terms of Service draft

If you want a minimal Terms of Service to link in the consent screen, create `/terms` as a Next.js page with:

```
# Terms of Service

**Effective date:** June 4, 2026

By using Wingman, you agree to these terms.

## 1. What Wingman is
Wingman is an AI assistant that reads your inbox, drafts replies in your voice, and helps you run your operating cadence. You are the user; we are the service.

## 2. What you agree to
- You will use Wingman only for legitimate business and personal communication purposes.
- You will not use Wingman to send spam, harassment, or content that violates law.
- You will not attempt to reverse-engineer, circumvent security, or harm the service.
- You will keep your Google account secure. If your account is compromised, you tell us within 24 hours.

## 3. What we agree to
- We will provide Wingman as described in the product.
- We will follow our Privacy Policy.
- We will not sell or share your data.
- We will give 30 days notice before discontinuing the service.

## 4. Payment (when applicable)
- Founding 100 users lock at original pricing for life.
- We charge monthly. Failed payments suspend access after 7 days.
- Refunds within 30 days for any reason.

## 5. Liability
- We provide Wingman "as is."
- We are not liable for emails sent by Wingman that you approved.
- We are not liable for missed emails if our classifier mis-prioritizes.
- Maximum liability is the amount you paid us in the prior 12 months.

## 6. Termination
- You can cancel anytime. We delete your data within 30 days.
- We can suspend accounts violating section 2 with notice.

## 7. Disputes
- Governed by laws of India.
- Disputes resolved by binding arbitration in Bangalore.

## 8. Contact
ajit23nayak@gmail.com
```

---

## Submission tracking

After you submit, expect Google emails to `ajit23nayak@gmail.com`. Save thread for reference.

| Date | Event | Status |
|---|---|---|
| (today) | Submission filed | Pending |
| ~1-2 weeks | Brand verification | |
| ~3-5 weeks | Security assessment requests | |
| ~5-7 weeks | Verification complete | |

Total expected: ~7 weeks from submission = ~July 23 if you submit by June 5.
