import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { Reveal } from "@/components/site/Reveal";

const SECTIONS = [
  {
    title: "Acceptance of these terms",
    body: [
      "By creating an account or using the Ship-It platform you agree to these terms. If you do not agree, do not use the platform.",
      "These terms apply to the website, the OpenCode plugin, the control plane and any server-agent you operate on our behalf.",
    ],
  },
  {
    title: "What the platform does",
    body: [
      "Ship-It builds software you submit through the OpenCode plugin and runs the resulting artifact inside an ephemeral sandbox. Builds execute in GitHub Actions; runtimes execute in short-lived containers.",
      "You keep ownership of the source you upload. We claim no rights over your code beyond what is needed to build and run it for you.",
    ],
  },
  {
    title: "Acceptable use",
    body: [
      "You may not use the platform to build or run malware, to attack third-party systems, to circumvent quota enforcement, or to probe or interfere with the infrastructure of other users.",
      "Runtimes are isolated from one another and from the host. Attempting to escape a sandbox, reach another user's filesystem, or extend a lease beyond its expiry is a breach of these terms.",
      "You may not resell raw platform access as a hosting product without a separate agreement.",
    ],
  },
  {
    title: "Quotas, billing and refunds",
    body: [
      "Each plan includes a monthly runtime allowance. Runtime time is measured while a session is actually running and is enforced on the server. Stopping early bills only the time used.",
      "Paid plans are billed through Whop. Subscriptions renew until cancelled, and access continues until the end of the paid period. You may cancel at any time from the dashboard.",
      "Because runtime time is consumed as it is used, we do not offer refunds for unused quota on a cancelled plan except where required by law.",
    ],
  },
  {
    title: "Availability and changes",
    body: [
      "We aim for high availability but do not guarantee uninterrupted service. Builds may fail, and agents may be unavailable; these events are reported rather than compensated automatically.",
      "We may change pricing, plan limits or platform behaviour. Material changes that reduce an existing allowance are announced before they take effect.",
    ],
  },
  {
    title: "Data and privacy",
    body: [
      "We store the source you upload, build logs, runtime logs and usage records in order to operate the platform. Account credentials are stored as salted hashes and full API keys are shown only once, at creation.",
      "Runtime sandboxes are destroyed when the session ends, including their filesystems.",
    ],
  },
  {
    title: "Warranties and liability",
    body: [
      "The platform is provided as is. We disclaim warranties to the fullest extent permitted by law.",
      "To the fullest extent permitted by law, our aggregate liability is limited to the amount you paid us in the twelve months before the claim. We are not liable for indirect or consequential loss.",
    ],
  },
  {
    title: "Termination",
    body: [
      "You may delete your account at any time. We may suspend an account that breaches these terms or where continued operation would create legal or security risk.",
      "On termination your data is deleted in line with the retention periods described in the privacy documentation.",
    ],
  },
];

export function TermsPage() {
  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />

      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-3xl">
          <h1
            className="stagger font-serif text-[clamp(2.5rem,6vw,4rem)] font-bold tracking-[-0.03em]"
            style={{ "--i": 0 } as React.CSSProperties}
          >
            <span className="text-gradient">Terms of Service</span>
          </h1>
          <p
            className="stagger mt-5 text-sm text-zinc-500"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            Last updated 30 September 2026
          </p>

          <div className="mt-14 space-y-12">
            {SECTIONS.map((section, i) => (
              <Reveal key={section.title} delay={i * 60}>
                <section>
                  <h2 className="text-xl font-semibold tracking-tight text-white">
                    {section.title}
                  </h2>
                  {section.body.map((paragraph, j) => (
                    <p
                      key={j}
                      className="mt-4 text-[15px] leading-relaxed text-zinc-400"
                    >
                      {paragraph}
                    </p>
                  ))}
                </section>
              </Reveal>
            ))}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
