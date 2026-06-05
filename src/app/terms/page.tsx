import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service | Wingman",
  description:
    "Terms of Service for Wingman — what you agree to when using the AI Chief of Staff product.",
};

export default function TermsOfServicePage() {
  return (
    <LegalPage>
      <h1>Terms of Service</h1>
      <p className="text-sm text-gray-500">
        <strong>Effective date:</strong> June 4, 2026
      </p>

      <p>By using Wingman, you agree to these terms.</p>

      <h2>1. What Wingman is</h2>
      <p>
        Wingman is an AI assistant that reads your inbox, drafts replies in
        your voice, and helps you run your operating cadence. You are the user;
        we are the service.
      </p>

      <h2>2. What you agree to</h2>
      <ul>
        <li>
          You will use Wingman only for legitimate business and personal
          communication purposes.
        </li>
        <li>
          You will not use Wingman to send spam, harassment, or content that
          violates law.
        </li>
        <li>
          You will not attempt to reverse-engineer, circumvent security, or
          harm the service.
        </li>
        <li>
          You will keep your Google account secure. If your account is
          compromised, you tell us within 24 hours.
        </li>
      </ul>

      <h2>3. What we agree to</h2>
      <ul>
        <li>We will provide Wingman as described in the product.</li>
        <li>We will follow our Privacy Policy.</li>
        <li>We will not sell or share your data.</li>
        <li>We will give 30 days notice before discontinuing the service.</li>
      </ul>

      <h2>4. Payment (when applicable)</h2>
      <ul>
        <li>Founding 100 users lock at original pricing for life.</li>
        <li>
          We charge monthly. Failed payments suspend access after 7 days.
        </li>
        <li>Refunds within 30 days for any reason.</li>
      </ul>

      <h2>5. Liability</h2>
      <ul>
        <li>
          We provide Wingman &ldquo;as is.&rdquo;
        </li>
        <li>
          We are not liable for emails sent by Wingman that you approved.
        </li>
        <li>
          We are not liable for missed emails if our classifier mis-prioritizes.
        </li>
        <li>
          Maximum liability is the amount you paid us in the prior 12 months.
        </li>
      </ul>

      <h2>6. Termination</h2>
      <ul>
        <li>You can cancel anytime. We delete your data within 30 days.</li>
        <li>We can suspend accounts violating section 2 with notice.</li>
      </ul>

      <h2>7. Disputes</h2>
      <ul>
        <li>Governed by laws of India.</li>
        <li>Disputes resolved by binding arbitration in Bangalore.</li>
      </ul>

      <h2>8. Contact</h2>
      <p>
        <code>ajit23nayak@gmail.com</code>
      </p>
    </LegalPage>
  );
}
