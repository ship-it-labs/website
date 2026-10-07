import { Link } from "react-router-dom";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { GhostCta, GlowCta } from "@/components/site/GlowCta";
import { usePageTitle } from "@/lib/page-title";

/**
 * Real 404: explains the miss and offers a way back, instead of silently
 * bouncing to the homepage where the user cannot tell a bad link from a
 * redirect.
 */
export function NotFoundPage() {
  usePageTitle("Page not found");

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />
      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-md text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-violet-300/80">
            404
          </p>
          <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Nothing here
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-zinc-400">
            This address does not match anything on Ship-It. The link may be
            old, mistyped, or pointing at something that was removed.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <GlowCta to="/">Back home</GlowCta>
            <GhostCta to="/docs">Read the docs</GhostCta>
          </div>
          <p className="mt-8 text-sm text-zinc-600">
            Signed in? Your{" "}
            <Link
              to="/dashboard"
              className="text-zinc-400 transition-colors hover:text-white"
            >
              dashboard
            </Link>{" "}
            is where the live things are.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
