# OAuth Submission Cheat Sheet

One-screen reference for filling the Google Cloud Console OAuth consent screen. Generated 2026-06-05. Source of truth: OAUTH_VERIFICATION.md.

## URL to open

```
https://console.cloud.google.com/apis/credentials/consent?project=gen-lang-client-0417020630
```

If the project ID has changed, replace it. Find it via the project picker top-left.

---

## Section: App information

| Field | Value |
|---|---|
| App name | `Wingman` |
| User support email | `ajit23nayak@gmail.com` |
| App logo | LEAVE EMPTY (skipping per 2026-06-05 decision; can add later via consent screen edit) |
| App home page | `https://project-wingman-pi.vercel.app` |
| App privacy policy link | `https://project-wingman-pi.vercel.app/privacy` |
| App terms of service link | `https://project-wingman-pi.vercel.app/terms` |
| Authorized domains | `vercel.app` |
| Developer contact information | `ajit23nayak@gmail.com` |

Click Save and Continue.

---

## Section: Scopes

Click "Add or Remove Scopes". Check these four boxes (search for each):

Non-sensitive:
- [ ] `.../auth/userinfo.email`
- [ ] `.../auth/userinfo.profile`
- [ ] `openid`

Sensitive / Restricted:
- [ ] `https://www.googleapis.com/auth/gmail.readonly` ← will prompt for justification
- [ ] `https://www.googleapis.com/auth/gmail.send` ← will prompt for justification

Click Update. Then paste the justifications below.

### Justification: `gmail.readonly`

```
Wingman is an AI Chief of Staff for founders. We read the user's Gmail inbox to provide three core features:

1. INBOX TRIAGE: We classify each incoming email into one of four buckets (Urgent, Important, FYI, Archive) so the user can focus only on what needs their attention. Without read access, classification is impossible.

2. VOICE LEARNING: We read the user's recently-sent emails to learn their writing voice. This is how Wingman generates draft replies that sound like the user, not like a generic AI assistant. We segment voice samples by relationship type (cold outreach, internal team, investor, peer) for higher fidelity.

3. CONTEXT-AWARE DRAFTING: When the user wants to reply to an incoming email, Wingman reads the full thread context to generate a relevant draft.

The user is in full control. Wingman never deletes emails, never modifies emails, and never marks emails as read. We only read.

Data retention: classifications and metadata are stored in our database (Supabase, Mumbai region, encrypted at rest, Row-Level Security enforced). Raw email content is fetched on demand and not retained beyond the API call. The user can request full data deletion at any time.
```

### Justification: `gmail.send`

```
Wingman drafts replies in the user's voice. The user reviews each draft, edits if needed, and clicks "Send." When they click send, we use gmail.send to deliver the reply via the user's Gmail account.

This is essential to the product's core promise: "drafts what's routine in your voice." Without send capability, users would have to copy-paste every draft into Gmail manually, defeating the time-savings value proposition.

Important safeguards:
- We never send autonomously. Every send is triggered by an explicit user click.
- The draft is always editable before sending - we are not a "fully automated assistant."
- We do not send to recipients the user hasn't already communicated with (replies only, no cold sends initiated by Wingman).

Data handling: we use gmail.send only at the moment of user-confirmed reply. We do not store sent message bodies after delivery. We do retain a record that "user X replied to thread Y at time Z" for audit and dashboard purposes.
```

Click Save and Continue.

---

## Section: Test users

Add at minimum:

- `ajit23nayak@gmail.com`

You can add up to 100 test users total. Add the 10 founding-trial users as they confirm. Test users can authenticate while verification is pending by clicking "Advanced -> Go to Wingman (unsafe)" on the consent screen.

Click Save and Continue.

---

## Section: Summary

Review everything. Click "Back to Dashboard".

Then on the OAuth consent screen Dashboard, look for the "Submit for verification" button at the top. Click it.

---

## Pre-flight checklist (verify all green before clicking Submit)

- [ ] `/privacy` returns HTTP 200 with real content (not 404, not placeholder)
- [ ] `/terms` returns HTTP 200 with real content
- [ ] Landing page footer links to both work
- [ ] App name says exactly "Wingman" (not "Project Wingman")
- [ ] Both Gmail justifications pasted exactly as above
- [ ] Authorized domain is `vercel.app`
- [ ] Your own email is in test users list
- [ ] Developer contact email is correct

If any box unchecked: do not submit. Reapplying eats 1-2 days of the 6-8 week verification clock.

---

## What happens after Submit

1. **Brand verification (1-2 weeks):** Google verifies the app name + domain. Usually fast and silent.
2. **Security assessment (2-4 weeks):** Google will email `ajit23nayak@gmail.com` asking for:
   - Demo video (45-60 sec) showing OAuth flow + read + draft + send
   - Privacy policy review
   - Confirmation of data handling (RLS, encryption, no sale)
3. **Verification complete (~6-8 weeks total):** Unverified-app warning goes away.

Trial users (added in Step 5) can authenticate during the wait window by clicking through the "Advanced -> unsafe" warning. This is acceptable for the trial cohort. Do not invite production-paying users until verification is complete.

---

## Logging the submission

Once you click Submit, paste the confirmation screen URL or screenshot into this file under a new "Submitted" section so we have a timestamped record.

---

## STATE AS OF 2026-06-05 (configured in Testing mode, not yet submitted for verification)

**Google Cloud project:** `gen-lang-client-0417020630` (display name: "Project Wingman 1")

**Configured:**
- App name: `Wingman`
- User support email + Developer contact: `ajit23nayak@gmail.com`
- App home: `https://project-wingman-pi.vercel.app`
- Privacy: `https://project-wingman-pi.vercel.app/privacy`
- Terms: `https://project-wingman-pi.vercel.app/terms`
- Authorized domain: `project-wingman-pi.vercel.app` (vercel.app is on PSL, must list subdomain)
- Audience type: External
- Scopes (5): `userinfo.email`, `userinfo.profile`, `openid`, `gmail.send` (sensitive), `gmail.readonly` (restricted)
- Test users (1): `ajit23nayak@gmail.com`
- Publishing status: **Testing** (deliberately, see below)

**NOT done (intentional, per 2026-06-05 trade-off decision):**
- App logo (skipped)
- Publish to Production (deferred until June 16 morning, after June 15 trial)
- Submit for verification (only becomes available after Publish)
- OAuth Client ID creation (separate concern, requires understanding whether Clerk or our code holds the Gmail OAuth client)

**Why we stopped here:**

In Production with restricted Gmail scopes (gmail.readonly), unverified apps BLOCK all users including those in the Test users list. Publishing today would block the June 15 trial. Better path: stay in Testing through trial, push to Production morning of June 16 to start the 6-8 week verification clock immediately after trial debrief.

**Trial-day mechanic (June 15):**

Each of the 10 trial founders authenticates by:
1. Click "Sign in with Google" on Wingman
2. See the Google "Wingman has not been verified by Google" warning
3. Click "Advanced" link bottom-left of warning
4. Click "Go to Wingman (unsafe)"
5. Proceed with normal OAuth consent

Each founder's email MUST be added as a Test user in `Audience → Test users` BEFORE they attempt sign-in. Otherwise they get a hard block.

**Outstanding pre-trial action:** add the 9 other trial founder emails to Test users when they confirm. Path: Google Cloud Console → Google Auth Platform → Audience → Test users → +Add users.

**June 16 morning action (task #45):**
1. Audience page → click **Publish app**
2. Confirm change to "In Production"
3. Verification Center auto-activates → click **Submit for verification** if visible (Google sometimes auto-submits, sometimes requires manual click)
4. Expect Google emails to `ajit23nayak@gmail.com` over next 6-8 weeks. Demo video request will come during security assessment (~weeks 3-5).
