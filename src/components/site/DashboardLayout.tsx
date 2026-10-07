import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { OfflineBanner } from "@/components/site/OfflineBanner";
import { Skeleton } from "@/components/site/Skeleton";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/dashboard", label: "Overview" },
  { to: "/dashboard/keys", label: "API keys" },
  { to: "/dashboard/billing", label: "Billing" },
  { to: "/dashboard/settings", label: "Settings" },
];

// Visible to admins only. The server enforces the same rule on every /admin/*
// endpoint, so hiding the tab is convenience, not security — but showing a tab
// that always 403s would be worse than hiding it.
const ADMIN_TAB = { to: "/dashboard/admin", label: "Admin" };

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
          <Link to="/" aria-label="Ship-It home">
            <img
              src="/logo.png"
              alt="Ship-It"
              className="h-7 w-auto"
              draggable={false}
            />
          </Link>

          {/* Scrolls horizontally on narrow screens instead of wrapping or
              clipping: shrink-0 keeps every tab tappable, the scroll region
              absorbs the overflow. The hamburger menu below covers xs. */}
          <nav className="mx-2 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:flex">
            {(user?.is_admin ? [...TABS, ADMIN_TAB] : TABS).map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm transition-colors duration-200",
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
            <span className="hidden text-xs text-zinc-500 lg:block">{user?.email}</span>
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
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 sm:hidden"
            >
              Menu
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="border-t border-white/[0.07] sm:hidden">
            {(user?.is_admin ? [...TABS, ADMIN_TAB] : TABS).map((tab) => (
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
      <OfflineBanner />
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
  loading,
}: {
  label: string;
  value: string;
  detail?: string;
  loading?: boolean;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-9 w-24" />
      ) : (
        <p className="mt-2 font-serif text-3xl font-bold tracking-tight text-white">{value}</p>
      )}
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
        // Paused is alive but idle, so it reads as neither healthy nor failed.
        : status === "paused"
          ? "bg-sky-400"
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
