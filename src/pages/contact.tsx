import { Link } from "react-router-dom";
import { ProsePage, ProseSection } from "@/components/site/ProsePage";
import { usePageTitle } from "@/lib/page-title";

export function ContactPage() {
  usePageTitle("Contact support");
  return (
    <ProsePage
      title="Contact support"
      subtitle="A human reads everything. Response within two business days, usually faster."
    >
      <ProseSection title="By email">
        <p>
          Write to{" "}
          <a
            href="mailto:support@ship-it.dev"
            className="text-violet-300 transition-colors hover:text-violet-200"
          >
            support@ship-it.dev
          </a>{" "}
          from your account address. Include what you expected, what happened
          instead, and — for billing — the Whop receipt and the email on the
          account.
        </p>
      </ProseSection>

      <ProseSection title="Before you write">
        <p>
          Most answers are already published: the{" "}
          <Link to="/faq" className="text-violet-300 transition-colors hover:text-violet-200">
            FAQ
          </Link>{" "}
          covers quotas, sessions, builds and billing, the{" "}
          <Link to="/docs" className="text-violet-300 transition-colors hover:text-violet-200">
            docs
          </Link>{" "}
          cover setup and troubleshooting, and{" "}
          <Link to="/status" className="text-violet-300 transition-colors hover:text-violet-200">
            status
          </Link>{" "}
          tells you whether the platform itself is having a bad day.
        </p>
      </ProseSection>

      <ProseSection title="What to include">
        <p>
          Account email, plan tier, the runtime or build id if one is involved
          (they are shown on the dashboard and in build logs), the exact error
          text, and the time it happened with timezone. A report with these
          five things is usually answered in one exchange; without them it
          takes three.
        </p>
      </ProseSection>

      <ProseSection title="Security issues">
        <p>
          Found a vulnerability? Email security@ship-it.dev with details and a
          way to reproduce. Please give a reasonable window to fix before any
          disclosure.
        </p>
      </ProseSection>
    </ProsePage>
  );
}
