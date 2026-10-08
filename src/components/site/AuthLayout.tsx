import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { SiteNav } from "@/components/site/SiteNav";

/**
 * Shared shell for the sign-in and sign-up screens: the same ambient background
 * and frosted nav as the marketing pages, with a single centred card.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />

      <main className="flex min-h-screen items-center justify-center px-4 py-16 sm:px-6 sm:py-32">
        <div
          className="stagger w-full max-w-md"
          style={{ "--i": 0 } as React.CSSProperties}
        >
          <div className="glass-strong rounded-3xl p-6 shadow-2xl sm:p-9">
            <h1 className="font-serif text-3xl font-bold tracking-tight text-white">
              {title}
            </h1>
            <p className="mt-2 text-sm text-zinc-400">{subtitle}</p>

            <div className="mt-8">{children}</div>
          </div>

          <div className="mt-6 text-center text-sm text-zinc-500">{footer}</div>
        </div>
      </main>
    </div>
  );
}

export function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
}) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="block text-xs font-medium uppercase tracking-[0.12em] text-zinc-500"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[15px] text-white placeholder:text-zinc-600 transition-all duration-200 outline-none focus:border-violet-400/50 focus:bg-white/[0.06] focus:ring-2 focus:ring-violet-500/25"
      />
    </div>
  );
}

export function PrimaryButton({
  children,
  busy,
  disabled,
  type = "submit",
}: {
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  type?: "submit" | "button";
}) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className="w-full rounded-xl bg-white px-5 py-3 text-[15px] font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-60"
    >
      {busy ? "Working…" : children}
    </button>
  );
}

export function GhostButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-white/10 px-5 py-3 text-[15px] text-zinc-400 transition-all duration-200 hover:border-white/20 hover:text-white"
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
      {children}
    </p>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
      {children}
    </p>
  );
}

export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-zinc-400 transition-colors hover:text-white">
      {children}
    </Link>
  );
}
