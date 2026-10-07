import { cn } from "@/lib/utils";

/**
 * Pulsing placeholder for stat tiles and panels while data loads. Fixed
 * heights come from the caller so content does not jump when real values
 * arrive — e.g. <Skeleton className="h-9 w-24" /> for a stat value.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-lg bg-white/[0.06]", className)}
    />
  );
}
