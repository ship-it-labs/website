import { useCopy } from "@/lib/use-copy";

/**
 * Small copy affordance with built-in feedback. One component so every copy
 * button shares the fallback path and the transient "Copied" label instead
 * of each call site wiring navigator.clipboard by hand.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { copied, copy } = useCopy();

  return (
    <button
      type="button"
      onClick={() => copy(text)}
      className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:border-white/25 hover:text-white"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
