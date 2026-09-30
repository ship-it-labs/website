import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/dashboard", label: "Overview" },
  { to: "/dashboard/keys", label: "API keys" },
  { to: "/dashboard/billing", label: "Billing" },
];

export function DashboardLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-zinc-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-[15px] font-semibold tracking-tight text-white">
            Ship-It
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {TABS.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={cn(
                  "rounded-lg px-3.5 py-2 text-sm transition-colors duration-200",
                  location.pathname === tab.to
                    ? "bg-white/[0.08] text-white"
                    : "text-zinc-400 hover:text-white"
                )}
              >
                {tab.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-zinc-500 sm:block">{user?.email}</span>
            <button
              type="button"
              onClick={async () => {
                await signOut();
                navigate("/");
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-white/20 hover:text-white"
            >
              Sign out
            </button>
            <button
              type="button"
              aria-label="Toggle navigation"
              onClick={() => setMenuOpen((v) => !v)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 md:hidden"
            >
              Menu
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="border-t border-white/[0.07] md:hidden">
            {TABS.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className="block px-6 py-3 text-sm text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-white"
              >
                {tab.label}
              </Link>
            ))}
          </div>
        )}
      </header>

      <main className="px-6 py-12">
        <div className="mx-auto max-w-6xl">
          <h1 className="font-serif text-4xl font-bold tracking-tight text-white">{title}</h1>
          <p className="mt-2 text-sm text-zinc-400">{subtitle}</p>
          <div className="mt-10">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("glass rounded-2xl", className)}>
      {(title || description) && (
        <header className="border-b border-white/[0.07] px-6 py-5">
          {title && (
            <h2 className="text-[15px] font-semibold text-white">{title}</h2>
          )}
          {description && (
            <p className="mt-1 text-sm text-zinc-500">{description}</p>
          )}
        </header>
      )}
      <div className="p-6">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 font-serif text-3xl font-bold tracking-tight text-white">{value}</p>
      {detail && <p className="mt-1 text-xs text-zinc-500">{detail}</p>}
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const tone =
    status === "running"
      ? "bg-emerald-400"
      : status === "starting"
        ? "bg-amber-400"
        : status === "expired" || status === "crashed"
          ? "bg-rose-400"
          : "bg-zinc-600";

  return (
    <span className="inline-flex items-center gap-2 text-sm text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      {status}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-white/10 px-5 py-8 text-center text-sm text-zinc-500">
      {children}
    </p>
  );
}
