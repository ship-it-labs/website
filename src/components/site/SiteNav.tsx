import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { OfflineBanner } from "@/components/site/OfflineBanner";
import { FeedbackButton } from "@/components/site/FeedbackButton";
import { cn } from "@/lib/utils";

const LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/docs", label: "Docs" },
  { to: "/faq", label: "FAQ" },
  { to: "/status", label: "Status" },
  { to: "/terms", label: "Terms" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Lock the page behind the mobile sheet so the body does not scroll through it.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
    <header className="fixed inset-x-0 top-0 z-50 px-4 pt-4 sm:px-6">
      <nav
        className={cn(
          "glass mx-auto flex max-w-6xl items-center justify-between rounded-2xl px-4 py-3 transition-all duration-500 sm:px-5",
          scrolled ? "shadow-2xl" : ""
        )}
      >
        <Link
          to="/"
          className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-white"
          aria-label="Ship-It home"
        >
          <img
            src="/logo.png"
            alt="Ship-It"
            className="h-7 w-auto"
            draggable={false}
          />
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={cn(
                "rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                location.pathname === link.to
                  ? "bg-white/10 text-white"
                  : "text-zinc-400 hover:text-white"
              )}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            to="/login"
            className="rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:text-white"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            className="group relative overflow-hidden rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
          >
            Start building
          </Link>
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="relative h-10 w-10 rounded-lg transition-colors hover:bg-white/5 md:hidden"
        >
          <span className="absolute inset-0 m-auto flex h-4 w-5 flex-col justify-between">
            <span
              className={cn(
                "block h-0.5 w-full rounded-full bg-white transition-all duration-300 ease-out",
                open && "translate-y-[7px] rotate-45"
              )}
            />
            <span
              className={cn(
                "block h-0.5 w-full rounded-full bg-white transition-all duration-200",
                open && "opacity-0"
              )}
            />
            <span
              className={cn(
                "block h-0.5 w-full rounded-full bg-white transition-all duration-300 ease-out",
                open && "-translate-y-[7px] -rotate-45"
              )}
            />
          </span>
        </button>
      </nav>

      <div
        className={cn(
          "glass-strong mx-auto mt-2 max-w-6xl overflow-hidden rounded-2xl transition-all duration-400 ease-out md:hidden",
          open
            ? "max-h-[26rem] opacity-100"
            : "pointer-events-none max-h-0 opacity-0"
        )}
      >
        <div className="flex flex-col gap-1 p-3">
          {LINKS.map((link, i) => (
            <Link
              key={link.to}
              to={link.to}
              style={{ transitionDelay: `${open ? i * 45 + 60 : 0}ms` }}
              className={cn(
                "rounded-xl px-4 py-3 text-sm transition-all duration-300",
                open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
                location.pathname === link.to
                  ? "bg-white/10 text-white"
                  : "text-zinc-300 hover:bg-white/5 hover:text-white"
              )}
            >
              {link.label}
            </Link>
          ))}
          <div className="mt-2 flex flex-col gap-2 border-t border-white/10 pt-3">
            <Link
              to="/login"
              className="rounded-xl px-4 py-2.5 text-center text-sm text-zinc-300"
            >
              Sign in
            </Link>
            <Link
              to="/signup"
              className="rounded-xl bg-white px-4 py-2.5 text-center text-sm font-medium text-zinc-950"
            >
              Start building
            </Link>
          </div>
        </div>
      </div>
    </header>
    <OfflineBanner />
    <FeedbackButton />
    </>
  );
}
