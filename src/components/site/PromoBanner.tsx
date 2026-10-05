import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The launch promo, shown in three shapes across the site. The code itself is
 * redeemed on Whop's checkout page — their API accepts no promo at checkout
 * creation, so the site's job is display plus copy-to-clipboard, and the cap
 * (50 redemptions) is enforced by the promo's settings in Whop, not here.
 */
export const PROMO_CODE = "FREE50";
export const PROMO_BLURB = "50% off Pro and Ultra, forever. First 50 redemptions.";

export function PromoPill({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(PROMO_CODE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denial leaves the code visible to select manually.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy the promo code"
      className={cn(
        "group inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs text-emerald-200 transition-colors hover:bg-emerald-500/15",
        className
      )}
    >
      <span className="font-mono font-semibold tracking-widest">{PROMO_CODE}</span>
      <span className="text-emerald-200/70">· 50% off forever</span>
      <span className="text-emerald-200/50 transition-colors group-hover:text-emerald-200">
        {copied ? "Copied!" : "Copy"}
      </span>
    </button>
  );
}

export function PromoBanner() {
  return (
    <div className="glass flex flex-col items-center justify-between gap-4 rounded-2xl border-emerald-400/20 p-6 text-center sm:flex-row sm:text-left">
      <div>
        <p className="text-[15px] font-semibold text-white">
          Launch offer: half price, forever
        </p>
        <p className="mt-1 text-sm text-zinc-400">
          {PROMO_BLURB} Enter it on the Whop checkout page when you subscribe —
          no expiry once applied.
        </p>
      </div>
      <PromoPill className="shrink-0" />
    </div>
  );
}

export function PromoNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs text-zinc-500", className)}>
      Have code <PromoInlineCode />? Enter it on the Whop checkout page for 50%
      off, forever. First 50 redemptions.
    </p>
  );
}

function PromoInlineCode() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard?.writeText(PROMO_CODE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Visible code remains selectable.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy the promo code"
      className="font-mono font-semibold text-emerald-300 transition-colors hover:text-emerald-200"
    >
      {copied ? "Copied!" : PROMO_CODE}
    </button>
  );
}
