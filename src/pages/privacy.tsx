import { ProsePage, ProseSection } from "@/components/site/ProsePage";
import { usePageTitle } from "@/lib/page-title";

export function PrivacyPage() {
  usePageTitle("Privacy Policy");
  return (
    <ProsePage
      title="Privacy Policy"
      subtitle="What Ship-It collects, why, and how to take it back. Last updated October 2026."
    >
      <ProseSection title="The short version">
        <p>
          An account is an email address, a password hash and a usage ledger.
          Payments run through Whop, which sees your payment details — we never
          do. Delete your account in Settings and the account, projects, builds,
          keys and sessions go with it.
        </p>
      </ProseSection>

      <ProseSection title="What we collect">
        <p>
          <strong className="text-zinc-200">Account data:</strong> your email
          address, an irreversible hash of your password (never the password),
          your plan tier and signup date.
        </p>
        <p>
          <strong className="text-zinc-200">Operational data:</strong> projects
          you upload, build commands and logs, runtime usage seconds, API keys
          you create (hashes only — a stolen database yields no usable keys),
          login sessions (device description, IP, timestamps) and support
          correspondence.
        </p>
        <p>
          <strong className="text-zinc-200">Payment data:</strong> handled
          entirely by Whop as the merchant of record. We store the subscription
          state (tier, status, renewal date, and any promo code you redeemed
          so the billing page can show the discount) and nothing about your
          card or bank. Whop's own privacy policy governs the payment itself.
        </p>
      </ProseSection>

      <ProseSection title="What we do with it">
        <p>
          Run the service: authenticate you, enforce quotas, bill usage, keep
          abuse out. Usage totals and anonymized billing events feed an admin
          dashboard used to operate the platform. Nothing is sold, rented or
          shared with advertisers. Ever.
        </p>
      </ProseSection>

      <ProseSection title="Project source and build logs">
        <p>
          Uploaded archives live only as long as needed to build and run. Build
          logs are visible to you and to platform administrators for debugging.
          Never upload secrets in plaintext — use your own secret management
          and reference values at runtime.
        </p>
      </ProseSection>

      <ProseSection title="Retention and deletion">
        <p>
          Usage months, anonymized billing events and bare webhook delivery
          records (no account attached) are kept for accounting and fraud
          review. Login sessions idle for 30 days are pruned automatically.
          Everything else dies with the account: Settings → Danger zone removes
          your projects, builds, keys, sessions and preferences immediately,
          and stops running runtimes first so nothing keeps billing a deleted
          account. Payment records remain with Whop under their retention
          rules.
        </p>
      </ProseSection>

      <ProseSection title="Contact">
        <p>
          Privacy questions or deletion requests that self-service cannot
          cover: use the Contact page. Requests are answered within 30 days.
        </p>
      </ProseSection>
    </ProsePage>
  );
}
