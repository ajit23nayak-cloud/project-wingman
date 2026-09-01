# Privacy Policy

**Effective date:** June 4, 2026
**Last updated:** June 4, 2026

Wingman ("we," "us," "our") is an AI Chief of Staff for founders. This policy explains what data Wingman collects, how we use it, and the rights you have over it. It is written in plain language because that's the only kind of privacy policy that anyone reads.

If you have questions, email `ajit23nayak@gmail.com`.

## 1. What we collect

When you connect Gmail to Wingman, we receive the following from Google via OAuth:
- Your Google account email address
- Your name and profile photo
- Read access to messages in your Gmail inbox
- Permission to send messages on your behalf when you approve a draft

When you sign up for the waitlist or use the product directly, we also collect:
- Information you provide to us (company name, the free-text "what's your cognitive overload" answer)
- Authentication state via Clerk (our identity provider)
- Email content from Gmail that Wingman classifies and stores in our database
- Drafts that Wingman generates in your voice
- Operational metadata (timestamps, classification results, error logs)

We do **not** collect:
- Your Google password (handled by Google, never seen by us)
- Payment information directly (handled by our future payment processor when paid tiers ship)
- Browsing data outside Wingman
- Location data
- Contacts beyond what's already in the emails we ingest

## 2. How we use it

We use your data **only** to provide the Wingman product to you. Specifically:
- Read your Gmail to classify which messages need your attention vs. which can be archived
- Learn your writing voice from your sent mail so we can draft replies in your style
- Generate suggested replies that you review and either send, edit, or discard
- Show you a dashboard of your inbox state
- Send you product email updates if you opt in

We do **not**:
- Sell your data to anyone, ever
- Use your data to train any general-purpose AI model
- Share your email content with other Wingman users
- Use your data for advertising

## 3. Where it lives

- **Email content + classifications + drafts:** stored in our database hosted by Supabase (PostgreSQL) in the Mumbai (ap-south-1) region
- **OAuth tokens:** stored and managed by Clerk (our identity provider). Wingman fetches fresh tokens per request and does not retain them in our database
- **Database security:** encrypted at rest by Supabase. Row-Level Security policies ensure your data is only accessible by you (via your authenticated session) or by Wingman's server-side workers (acting on your behalf to classify or draft)
- **Application hosting:** Vercel (region: Mumbai)
- **AI processing:** Google Gemini API (for classification + drafting). Email snippets are sent to Gemini for the duration of the API call only. Google's terms govern that data — Wingman has no control over Gemini's data retention but uses the standard paid-tier API where Google states data is not used for model training

## 4. How long we keep it

- Email classifications and drafts: until you delete your account
- OAuth tokens: managed by Clerk, refreshed automatically, deleted when you disconnect
- Waitlist application: deleted within 90 days of being invited or rejected, unless you become an active user
- Logs: retained for 30 days for operational purposes, then purged

If you delete your account, we delete all your data within 30 days. Backups containing your data are purged within 90 days.

## 5. Your rights

You can, at any time:
- Request a copy of all data we have on you
- Request deletion of all your data
- Disconnect Gmail (which immediately stops Wingman from reading any further mail)
- Stop sharing voice samples by deleting them from your voice library

Email `ajit23nayak@gmail.com` to exercise any of these rights. We will respond within 7 days.

You also have rights granted by applicable law:
- **GDPR** (if you are in the European Economic Area): right to access, rectification, erasure, restriction, objection, portability, and to lodge a complaint with your supervisory authority
- **CCPA** (if you are a California resident): right to know, delete, and opt out of sale (we don't sell, so opt-out is automatic)
- **DPDP Act** (if you are in India): right to access, correction, erasure, and grievance redressal

## 6. Children's data

Wingman is for founders and business operators. We do not knowingly collect data from anyone under 16. If we learn that we have, we will delete it.

## 7. Security

We take security seriously but no system is perfectly secure. We:
- Use Row-Level Security at the database layer so users cannot read each other's data
- Encrypt data in transit (HTTPS everywhere) and at rest (Supabase default)
- Use Clerk for identity management so we never see your Google password
- Limit access to production data to the founder (Ajit Nayak) only
- Keep our codebase open to audit by paying customers on request

If we ever experience a security incident affecting your data, we will notify you within 72 hours.

## 8. Changes to this policy

We may update this policy. When we do, we will:
- Update the "Last updated" date at the top
- Email all active users with a summary of changes
- Give at least 14 days notice before material changes take effect

## 9. Contact

For privacy questions, data requests, or anything else:

**Ajit Nayak**
Creator of Wingman
Email: ajit23nayak@gmail.com
Address: Bangalore, India

For unresolved concerns under the DPDP Act, you may also contact the Data Protection Board of India.
