import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { Reveal } from "@/components/site/Reveal";

interface Plan {
  id: string;
  name: string;
  runtime_hours_per_month: number;
  max_runtime_hours: number;
  max_concurrent_runtimes: number;
  max_ram_mb: number;
  cpu: number;
  build_timeout_seconds: number;
  price_cents: number;
}

// Shown until /api/v1/plans responds. Mirrors the server's seed so the page
// never advertises a tier or price the control plane will not honour.
const FALLBACK: Plan[] = [
  {
    id: "free",
    name: "Free",
    runtime_hours_per_month: 24,
    max_runtime_hours: 3,
    max_concurrent_runtimes: 1,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 180,
    price_cents: 0,
  },
  {
    id: "pro",
    name: "Pro",
    runtime_hours_per_month: 250,
    max_runtime_hours: 6,
    max_concurrent_runtimes: 2,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 300,
    price_cents: 499,
  },
  {
    id: "plus",
    name: "Plus",
    runtime_hours_per_month: 500,
    max_runtime_hours: 24,
    max_concurrent_runtimes: 2,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 600,
    price_cents: 999,
  },
  {
    id: "ultra",
    name: "Ultra",
    runtime_hours_per_month: 1000,
    max_runtime_hours: 24,
    max_concurrent_runtimes: 3,
    max_ram_mb: 512,
    cpu: 0.1,
    build_timeout_seconds: 600,
    price_cents: 1299,
  },
];

export function PricingPage() {
  const [plans, setPlans] = useState<Plan[]>(FALLBACK);
  const [monthly, setMonthly] = useState(true);

  useEffect(() => {
    api
      .get<{ plans: Plan[] }>("/api/v1/plans")
      .then((result) => {
        if (result.plans?.length) setPlans(result.plans);
      })
      .catch(() => {
        // The page stays useful without the API; the seeded values match.
      });
  }, []);

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />

      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <h1
              className="stagger font-serif text-[clamp(2.5rem,6vw,4.5rem)] font-bold leading-[1] tracking-[-0.03em]"
              style={{ "--i": 0 } as React.CSSProperties}
            >
              <span className="text-gradient">Pay for runtime.</span>
              <br />
              Nothing else.
            </h1>
            <p
              className="stagger mx-auto mt-6 max-w-xl text-lg text-zinc-400"
              style={{ "--i": 1 } as React.CSSProperties}
            >
              Builds are included. You are charged for the time your apps are
              actually running.
            </p>

            <div
              className="stagger mt-9 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1 backdrop-blur-md"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              <button
                type="button"
                onClick={() => setMonthly(true)}
                className={cn(
                  "rounded-full px-5 py-2 text-sm transition-all duration-200",
                  monthly
                    ? "bg-white text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                )}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setMonthly(false)}
                className={cn(
                  "rounded-full px-5 py-2 text-sm transition-all duration-200",
                  !monthly
                    ? "bg-white text-zinc-950"
                    : "text-zinc-400 hover:text-white"
                )}
              >
                Annual
              </button>
            </div>
          </div>

          <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan, i) => {
              const featured = plan.id === "pro";
              const price = monthly
                ? plan.price_cents
                : Math.round(plan.price_cents * 0.8);

              return (
                <Reveal key={plan.id} delay={i * 110}>
                  <article
                    className={cn(
                      "glass relative h-full rounded-2xl p-8 transition-all duration-300 hover:-translate-y-1",
                      featured
                        ? "border-violet-400/30 glow-violet lg:-my-4 lg:py-12"
                        : "hover:border-white/15"
                    )}
                  >
                    {featured && (
                      <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-[11px] font-medium uppercase tracking-widest text-violet-200 backdrop-blur-md">
                        Most popular
                      </span>
                    )}

                    <h2 className="text-lg font-semibold text-white">{plan.name}</h2>

                    <div className="mt-5 flex items-baseline gap-1">
                      <span className="font-serif text-5xl font-bold tracking-tight text-white">
                        ${(price / 100).toFixed(0)}
                      </span>
                      <span className="text-sm text-zinc-500">
                        {price === 0 ? "forever" : "/ month"}
                      </span>
                    </div>

                    <ul className="mt-8 space-y-3.5 text-sm">
                      <Row
                        label={`${plan.runtime_hours_per_month} runtime hours`}
                        hint="per month"
                      />
                      <Row label={`Up to ${plan.max_runtime_hours}h per session`} />
                      <Row
                        label={`${plan.max_concurrent_runtimes} instance${
                          plan.max_concurrent_runtimes === 1 ? "" : "s"
                        } at a time`}
                        hint={
                          plan.max_concurrent_runtimes > 1 ? "running together" : "concurrently"
                        }
                      />
                      <Row label={`${plan.build_timeout_seconds}s build timeout`} />
                      <Row label="Ephemeral sandbox" />
                      <Row
                        label={
                          plan.price_cents === 0
                            ? "Shared capacity"
                            : "Reserved capacity"
                        }
                        hint={
                          plan.price_cents === 0
                            ? "when demand allows"
                            : "always available"
                        }
                      />
                    </ul>

                    <Link
                      to="/signup"
                      className={cn(
                        "mt-9 block rounded-xl px-5 py-3 text-center text-sm font-medium transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]",
                        featured
                          ? "bg-white text-zinc-950"
                          : "border border-white/15 text-white hover:bg-white/5"
                      )}
                    >
                      {price === 0 ? "Start free" : `Get ${plan.name}`}
                    </Link>
                  </article>
                </Reveal>
              );
            })}
          </div>

          <Reveal delay={200}>
            <p className="mt-14 text-center text-sm text-zinc-600">
              Charged through Whop. Cancel any time; access continues until the end
              of the period.
            </p>
          </Reveal>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Row({ label, hint }: { label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-3 text-zinc-300">
      <svg
        viewBox="0 0 24 24"
        className="mt-0.5 h-4 w-4 shrink-0 text-violet-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <span>
        {label}
        {hint && <span className="text-zinc-600"> · {hint}</span>}
      </span>
    </li>
  );
}
