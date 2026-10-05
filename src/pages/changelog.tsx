import { ProsePage } from "@/components/site/ProsePage";

interface Entry {
  date: string;
  title: string;
  items: string[];
}

const ENTRIES: Entry[] = [
  {
    date: "October 2026",
    title: "Billing expansion and account settings",
    items: [
      "Billing shows your plan, price, renewal date and status, with Upgrade, Downgrade and Cancel where each makes sense.",
      "Upgrading auto-cancels the old membership so two plans never bill at once.",
      "New Settings page: password and email change, device sessions, preferences and self-serve account deletion.",
    ],
  },
  {
    date: "October 2026",
    title: "Simpler tiers",
    items: [
      "Plus is gone, merged into Ultra. Free holds 10 hours a month; Pro moves to $9 with 3 instances; Ultra to $19 with 5.",
      "Sale pricing: plans can carry a note and a crossed-out previous price.",
    ],
  },
  {
    date: "September 2026",
    title: "Runtime controls and live countdowns",
    items: [
      "Click any runtime for pause, resume, restart, specs and delete.",
      "Every runtime shows a live countdown to its session timeout.",
      "Usage ticks every second while a runtime is up.",
    ],
  },
  {
    date: "September 2026",
    title: "Admin panel",
    items: [
      "Overview, users, runtimes, builds, payments with MRR, analytics, plan editing and platform settings.",
    ],
  },
];

export function ChangelogPage() {
  return (
    <ProsePage
      title="Changelog"
      subtitle="What shipped, newest first. No marketing — just the changes."
    >
      <ol className="relative space-y-10 border-l border-white/[0.08] pl-8">
        {ENTRIES.map((entry) => (
          <li key={`${entry.date}-${entry.title}`} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[37px] top-1.5 h-2.5 w-2.5 rounded-full bg-violet-400"
            />
            <p className="font-mono text-xs uppercase tracking-widest text-zinc-600">
              {entry.date}
            </p>
            <h2 className="mt-1 text-lg font-semibold text-white">{entry.title}</h2>
            <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-zinc-400">
              {entry.items.map((item) => (
                <li key={item.slice(0, 32)} className="flex gap-3">
                  <span aria-hidden="true" className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-zinc-600" />
                  {item}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </ProsePage>
  );
}
