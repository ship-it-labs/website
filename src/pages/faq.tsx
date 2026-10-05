import { useState } from "react";
import { Link } from "react-router-dom";
import { ProsePage } from "@/components/site/ProsePage";
import { cn } from "@/lib/utils";

const ITEMS: { question: string; answer: string[] }[] = [
  {
    question: "How do monthly hours work?",
    answer: [
      "Every plan includes a number of runtime hours per month — 10 on Free, 250 on Pro, 1,000 on Ultra. A per-second ticker bills while your apps run, and the dashboard counts down live. When the hours are gone, new starts are refused until the next month; running apps finish their sessions.",
    ],
  },
  {
    question: "What is a session, and what happens when it ends?",
    answer: [
      "A session is one running app, capped by your tier: 3 hours on Free, 6 on Pro, 24 on Ultra. The dashboard shows a live countdown per runtime. At zero the container is stopped and its filesystem destroyed — sessions are ephemeral by design, so treat any data you care about as already backed up elsewhere.",
    ],
  },
  {
    question: "Can I pause a runtime instead of stopping it?",
    answer: [
      "Yes. Pausing freezes the app in place: it keeps its URL and its lease keeps ticking, but it serves nothing and can be resumed instantly. Useful for holding a demo slot without burning attention — though not usage, which follows the lease, not the process state.",
    ],
  },
  {
    question: "How do builds work, and where do they run?",
    answer: [
      "The agent writes install, build and test commands from your prompt and submits them to an isolated pipeline with a hard timeout (180s Free, 300s Pro, 600s Ultra). Builds run on 16GB / 4vCPU machines — never on the small boxes that host runtimes. Every build streams logs you can read from the dashboard by clicking it.",
    ],
  },
  {
    question: "How does billing work? Can I upgrade, downgrade, cancel?",
    answer: [
      "Checkout and recurring billing run through Whop. Upgrade any time from the Billing page — the old membership is cancelled automatically so you never double-pay. Downgrade two ways: switch instantly inside Whop (prorated), or cancel now and let the paid period run out, then subscribe to the cheaper tier. Cancel any time; access continues to the end of the paid period and nothing further is charged.",
    ],
  },
  {
    question: "What do I get on Free, exactly?",
    answer: [
      "10 runtime hours a month, 3-hour sessions, one app at a time, shared capacity that may queue under load. Enough to build something real. No card required.",
    ],
  },
  {
    question: "I paid but my plan did not change. What now?",
    answer: [
      "Plan changes apply through payment webhooks, usually within seconds. First check the Billing page — if it still shows the old tier after a few minutes, check Whop for the receipt, then contact support with the receipt and your account email. Never pay twice to 'fix' it; duplicate memberships are exactly what the upgrade flow prevents.",
    ],
  },
  {
    question: "How do I delete my account and data?",
    answer: [
      "Settings → Danger zone. It stops running runtimes and deletes projects, builds, keys, sessions and preferences immediately. Payment records stay with Whop. This cannot be undone.",
    ],
  },
];

export function FaqPage() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <ProsePage
      title="Frequently asked questions"
      subtitle="Quotas, sessions, builds, billing. Still stuck?"
    >
      <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.07] bg-white/[0.02]">
        {ITEMS.map((item, index) => {
          const expanded = open === index;
          return (
            <div key={item.question}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : index)}
                aria-expanded={expanded}
                className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
              >
                <span className="text-[15px] font-medium text-white">
                  {item.question}
                </span>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  className={cn(
                    "h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200",
                    expanded && "rotate-180"
                  )}
                >
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {expanded && (
                <div className="space-y-3 px-6 pb-6 text-[15px] leading-relaxed text-zinc-400">
                  {item.answer.map((paragraph) => (
                    <p key={paragraph.slice(0, 24)}>{paragraph}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-8 text-sm text-zinc-500">
        Not answered here? <Link to="/contact" className="text-violet-300 transition-colors hover:text-violet-200">Contact support</Link> — include your account email and, for billing, the Whop receipt.
      </p>
    </ProsePage>
  );
}
