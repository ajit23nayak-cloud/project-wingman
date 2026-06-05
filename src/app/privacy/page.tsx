import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | Wingman",
  description:
    "How Wingman collects, uses, and stores your data. Plain-language privacy policy for the AI Chief of Staff product.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage>
      <h1>Privacy Policy</h1>
      <p className="text-sm text-gray-500">
        <strong>Effective date:</strong> June 4, 2026
        <br />
        <strong>Last updated:</strong> June 4, 2026
      </p>

      <p>
        Wingman (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;) is an
        AI Chief of Staff for founders. This policy explains what data Wingman
        collects, how we use it, and the rights you have over it. It is written
        in plain language because that&apos;s the only kind of privacy policy
        that anyone reads.
      </p>

      <p>
        If you have questions, email{" "}
        <code>ajit23nayak@gmail.com</code>.
      </p>

      <h2>1. What we collect</h2>
      <p>
        When you connect Gmail to Wingman, we receive the following from Google
        via OAuth:
      </p>
      <ul>
        <li>Your Google account email address</li>
        <li>Your name and profile photo</li>
        <li>Read access to messages in your Gmail inbox</li>
        <li>Permission to send messages on your behalf when you approve a draft</li>
      </ul>
      <p>
        When you sign up for the waitlist or use the product directly, we also
        collect:
      </p>
      <ul>
        <li>
          Information you provide to us (company name, the free-text
          &ldquo;what&apos;s your cognitive overload&rdquo; answer)
        </li>
        <li>Authentication state via Clerk (our identity provider)</li>
        <li>
          Email content from Gmail that Wingman classifies and stores in our
          database
        </li>
        <li>Drafts that Wingman generates in your voice</li>
        <li>
          Operational metadata (timestamps, classification results, error logs)
        </li>
      </ul>
      <p>
        We do <strong>not</strong> collect:
      </p>
      <ul>
        <li>Your Google password (handled by Google, never seen by us)</li>
        <li>
          Payment information directly (handled by our future payment processor
          when paid tiers ship)
        </li>
        <li>Browsing data outside Wingman</li>
        <li>Location data</li>
        <li>Contacts beyond what&apos;s already in the emails we ingest</li>
      </ul>

      <h2>2. How we use it</h2>
      <p>
        We use your data <strong>only</strong> to provide the Wingman product
        to you. Specifically:
      </p>
      <ul>
        <li>
          Read your Gmail to classify which messages need your attention vs.
          which can be archived
        </li>
        <li>
          Learn your writing voice from your sent mail so we can draft replies
          in your style
        </li>
        <li>
          Generate suggested replies that you review and either send, edit, or
          discard
        </li>
        <li>Show you a dashboard of your inbox state</li>
        <li>Send you product email updates if you opt in</li>
      </ul>
      <p>
        We do <strong>not</strong>:
      </p>
      <ul>
        <li>Sell your data to anyone, ever</li>
        <li>Use your data to train any general-purpose AI model</li>
        <li>Share your email content with other Wingman users</li>
        <li>Use your data for advertising</li>
      </ul>

      <h2>3. Where it lives</h2>
      <ul>
        <li>
          <strong>Email content + classifications + drafts:</strong> stored in
          our database hosted by Supabase (PostgreSQL) in the Mumbai
          (ap-south-1) region
        </li>
        <li>
          <strong>OAuth tokens:</strong> stored and managed by Clerk (our
          identity provider). Wingman fetches fresh tokens per request and does
          not retain them in our database
        </li>
        <li>
          <strong>Database security:</strong> encrypted at rest by Supabase.
          Row-Level Security policies ensure your data is only accessible by
          you (via your authenticated session) or by Wingman&apos;s server-side
          workers (acting on your behalf to classify or draft)
        </li>
        <li>
          <strong>Application hosting:</strong> Vercel (region: Mumbai)
        </li>
        <li>
          <strong>AI processing:</strong> Google Gemini API (for classification
          + drafting). Email snippets are sent to Gemini for the duration of
          the API call only. Google&apos;s terms govern that data — Wingman has
          no control over Gemini&apos;s data retention but uses the standard
          paid-tier API where Google states data is not used for model training
        </li>
      </ul>

      <h2>4. How long we keep it</h2>
      <ul>
        <li>Email classifications and drafts: until you delete your account</li>
        <li>
          OAuth tokens: managed by Clerk, refreshed automatically, deleted when
          you disconnect
        </li>
        <li>
          Waitlist application: deleted within 90 days of being invited or
          rejected, unless you become an active user
        </li>
        <li>Logs: retained for 30 days for operational purposes, then purged</li>
      </ul>
      <p>
        If you delete your account, we delete all your data within 30 days.
        Backups containing your data are purged within 90 days.
      </p>

      <h2>5. Your rights</h2>
      <p>You can, at any time:</p>
      <ul>
        <li>Request a copy of all data we have on you</li>
        <li>Request deletion of all your data</li>
        <li>
          Disconnect Gmail (which immediately stops Wingman from reading any
          further mail)
        </li>
        <li>
          Stop sharing voice samples by deleting them from your voice library
        </li>
      </ul>
      <p>
        Email <code>ajit23nayak@gmail.com</code> to exercise any of these
        rights. We will respond within 7 days.
      </p>
      <p>You also have rights granted by applicable law:</p>
      <ul>
        <li>
          <strong>GDPR</strong> (if you are in the European Economic Area):
          right to access, rectification, erasure, restriction, objection,
          portability, and to lodge a complaint with your supervisory authority
        </li>
        <li>
          <strong>CCPA</strong> (if you are a California resident): right to
          know, delete, and opt out of sale (we don&apos;t sell, so opt-out is
          automatic)
        </li>
        <li>
          <strong>DPDP Act</strong> (if you are in India): right to access,
          correction, erasure, and grievance redressal
        </li>
      </ul>

      <h2>6. Children&apos;s data</h2>
      <p>
        Wingman is for founders and business operators. We do not knowingly
        collect data from anyone under 16. If we learn that we have, we will
        delete it.
      </p>

      <h2>7. Security</h2>
      <p>We take security seriously but no system is perfectly secure. We:</p>
      <ul>
        <li>
          Use Row-Level Security at the database layer so users cannot read
          each other&apos;s data
        </li>
        <li>
          Encrypt data in transit (HTTPS everywhere) and at rest (Supabase
          default)
        </li>
        <li>Use Clerk for identity management so we never see your Google password</li>
        <li>Limit access to production data to the founder (Ajit Nayak) only</li>
        <li>Keep our codebase open to audit by paying customers on request</li>
      </ul>
      <p>
        If we ever experience a security incident affecting your data, we will
        notify you within 72 hours.
      </p>

      <h2>8. Changes to this policy</h2>
      <p>We may update this policy. When we do, we will:</p>
      <ul>
        <li>Update the &ldquo;Last updated&rdquo; date at the top</li>
        <li>Email all active users with a summary of changes</li>
        <li>Give at least 14 days notice before material changes take effect</li>
      </ul>

      <h2>9. Contact</h2>
      <p>For privacy questions, data requests, or anything else:</p>
      <p>
        <strong>Ajit Nayak</strong>
        <br />
        Creator of Wingman
        <br />
        Email: <code>ajit23nayak@gmail.com</code>
        <br />
        Address: Bangalore, India
      </p>
      <p>
        For unresolved concerns under the DPDP Act, you may also contact the
        Data Protection Board of India.
      </p>
    </LegalPage>
  );
}
