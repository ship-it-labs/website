import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface GlowCtaProps {
  to: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Primary call to action. The arrow rests behind the label and slides through it
 * on hover, which reads as direction rather than as decoration.
 */
export function GlowCta({ to, children, className }: GlowCtaProps) {
  return (
    <Link
      to={to}
      className={cn(
        "group relative inline-flex items-center gap-2.5 overflow-hidden rounded-full px-7 py-3.5",
        "text-[15px] font-medium text-white",
        "transition-transform duration-200 ease-out hover:scale-[1.02] active:scale-[0.99]",
        "bg-white/[0.07] backdrop-blur-xl border border-white/15",
        "glow-violet",
        className
      )}
    >
      <span
        aria-hidden
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-violet-500/45 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
      />
      <span className="relative z-10">{children}</span>
      <span className="relative z-10 flex h-5 w-5 items-center justify-center overflow-hidden">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 transition-transform duration-300 ease-out group-hover:translate-x-1"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </Link>
  );
}

interface GhostCtaProps {
  to: string;
  children: React.ReactNode;
}

export function GhostCta({ to, children }: GhostCtaProps) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-medium text-zinc-300 transition-all duration-200 hover:scale-[1.02] hover:bg-white/5 hover:text-white active:scale-[0.99]"
    >
      {children}
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </Link>
  );
}
