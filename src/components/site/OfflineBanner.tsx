import { useOnline } from "@/lib/use-online";

/**
 * Slim fixed banner shown only while the browser reports no connectivity.
 * Nothing to dismiss — it clears itself on the next online event.
 */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-400/25 bg-amber-500/10 px-6 py-2 text-center text-xs text-amber-200 backdrop-blur-xl"
    >
      You are offline — pages may be stale and actions will fail until the
      connection returns.
    </div>
  );
}
