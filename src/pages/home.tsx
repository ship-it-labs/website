import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { GlowCta, GhostCta } from "@/components/site/GlowCta";
import { Reveal } from "@/components/site/Reveal";
import { HeroTexture } from "@/components/site/HeroTexture";
import { PromoPill } from "@/components/site/PromoBanner";
import { WrenchIcon, PlayIcon, ShieldIcon } from "@/components/site/FeatureIcon";
import { usePageTitle } from "@/lib/page-title";
import { useAuth } from "@/lib/auth-context";

const FEATURES = [
  {
    title: "The AI builds it",
    body: "Describe what you want. The agent writes the install and build commands, submits them to a 3-minute isolated pipeline, reads the logs, and fixes what broke. You never touch a CI config.",
    accent: "from-violet-500/25",
    icon: WrenchIcon,
  },
  {
    title: "It just runs",
    body: "Every successful build starts in an ephemeral sandbox with the full filesystem to itself. Sessions cap at three hours and are torn down with the filesystem when the lease ends.",
    accent: "from-cyan-400/25",
    icon: PlayIcon,
  },
  {
    title: "You keep control",
    body: "Server-enforced quotas and leases. The agent cannot extend its own session even if asked to, so your allowance is never spent on something you did not start.",
    accent: "from-fuchsia-500/25",
    icon: ShieldIcon,
  },
];

const STEPS = [
  { n: "01", title: "Install the plugin", body: "One npm package and an account key in opencode.json." },
  { n: "02", title: "Ask for what you want", body: "Describe the app. The AI uploads your project and builds it in GitHub Actions." },
  { n: "03", title: "Get a live URL", body: "The artifact starts in a sandbox on the least loaded agent, with logs and metrics on demand." },
];

export function HomePage() {
  usePageTitle("Ship the idea. Let the agent run it");
  // Signed-in visitors get a way back to the product, not a second signup
  // pitch. The nav already adapts elsewhere; the hero is where it matters.
  const { user, loading } = useAuth();
  const signedIn = !loading && !!user;

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />

      <main>
        <section className="relative px-6 pb-24 pt-36 sm:pt-44">
          {/* Two columns on wide screens so the texture fills the space beside
              the headline; below that it stacks under the copy. */}
          <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-12">
            <div>
            <div
              className="stagger inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs text-zinc-400 backdrop-blur-md"
              style={{ "--i": 0 } as React.CSSProperties}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span
                  className="absolute inline-flex h-full w-full rounded-full bg-violet-400"
                  style={{ animation: "pulse-ring 2.4s ease-out infinite" }}
                />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-400" />
              </span>
              Builds run in GitHub Actions. Nothing compiles on your runtime.
            </div>

            <h1
              className="stagger mt-8 max-w-4xl font-serif text-[clamp(2.75rem,8vw,5.5rem)] font-bold leading-[0.95] tracking-[-0.03em]"
              style={{ "--i": 1 } as React.CSSProperties}
            >
              <span className="text-gradient">Ship the idea.</span>
              <br />
              Let the agent run it.
            </h1>

            <p
              className="stagger mt-8 max-w-xl text-lg leading-relaxed text-zinc-400"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              Ship-It turns a plain-language request into a real build and a live
              sandbox. The AI writes the commands, reads the failure, and iterates
              until it works.
            </p>

            <div
              className="stagger mt-10 flex flex-col gap-3 sm:flex-row sm:items-center"
              style={{ "--i": 3 } as React.CSSProperties}
            >
              {signedIn ? (
                <GlowCta to="/dashboard">Go to dashboard</GlowCta>
              ) : (
                <GlowCta to="/signup">Start building free</GlowCta>
              )}
              <GhostCta to="/docs">Read the docs</GhostCta>
            </div>

            <div
              className="stagger mt-6 flex flex-col items-start gap-3"
              style={{ "--i": 4 } as React.CSSProperties}
            >
              <p className="text-sm text-zinc-600">
                10 runtime hours a month on the free plan. No card required.
              </p>
              <PromoPill />
            </div>
            </div>

            {/* Decorative only, so it is hidden from assistive technology and
                collapses away on small screens where it would just push the
                call to action down. */}
            <div
              className="stagger hidden h-[340px] lg:block"
              style={{ "--i": 2 } as React.CSSProperties}
            >
              <HeroTexture />
            </div>
          </div>
        </section>

        <section className="relative px-6 py-20">
          <div className="mx-auto grid max-w-6xl gap-5 md:grid-cols-3">
            {FEATURES.map((feature, i) => {
              const Icon = feature.icon;
              return (
                <Reveal key={feature.title} delay={i * 110}>
                  <article className="glass group h-full rounded-2xl p-7 transition-all duration-300 hover:-translate-y-1 hover:border-white/15">
                    <div
                      className={`mb-5 grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br ${feature.accent} to-transparent text-white ring-1 ring-inset ring-white/10 transition-transform duration-300 group-hover:scale-105`}
                    >
                      <Icon className="h-[18px] w-[18px]" />
                    </div>
                    <h3 className="text-lg font-semibold tracking-tight text-white">
                      {feature.title}
                    </h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-zinc-400">
                      {feature.body}
                    </p>
                  </article>
                </Reveal>
              );
            })}
          </div>
        </section>

        <section className="relative px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="font-serif text-4xl font-bold tracking-tight text-white sm:text-5xl">
                Three steps, then it is live.
              </h2>
            </Reveal>

            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <Reveal key={step.n} as="li" delay={i * 120}>
                  <div className="glass h-full rounded-2xl p-7">
                    <p className="font-mono text-xs tracking-widest text-violet-300/80">
                      {step.n}
                    </p>
                    <h3 className="mt-4 text-base font-semibold text-white">
                      {step.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                      {step.body}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        <section className="relative px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <div className="glass-strong relative overflow-hidden rounded-3xl px-8 py-16 text-center sm:px-16">
                <div
                  aria-hidden
                  className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-violet-500/25 blur-[100px]"
                />
                <h2 className="relative font-serif text-4xl font-bold tracking-tight text-white sm:text-5xl">
                  Start with 10 hours free.
                </h2>
                <p className="relative mx-auto mt-5 max-w-lg text-[15px] leading-relaxed text-zinc-400">
                  Enough to build something real and keep it running for most of a
                  working day.
                </p>
                <div className="relative mt-9 flex justify-center">
                  {signedIn ? (
                    <GlowCta to="/dashboard">Go to dashboard</GlowCta>
                  ) : (
                    <GlowCta to="/signup">Create an account</GlowCta>
                  )}
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
