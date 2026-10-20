import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ConnectTabs } from "@/components/site/ConnectTabs";

/**
 * The first-run popup.
 *
 * A new account lands on a blank dashboard with no idea that a whole
 * platform is waiting behind an MCP server. This shows up once, right after
 * the first sign-in, and says the one useful thing: here is the server URL,
 * here is the snippet for your client, and your agent will sign you in.
 *
 * It is deliberately not a wizard: one popup, one decision, and a link to the
 * documentation for anyone who wants the long version.
 */

const SEEN_KEY = "shipit:connect-popup-seen";

function alreadySeen(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${SEEN_KEY}:${userId}`) === "1";
  } catch {
    // Storage can be blocked entirely (private mode, embedded views). Treat
    // that as "show it": a repeated popup is a smaller harm than none.
    return false;
  }
}

function remember(userId: string): void {
  try {
    window.localStorage.setItem(`${SEEN_KEY}:${userId}`, "1");
  } catch {
    // Nothing to do: the popup simply shows again next time.
  }
}

export function ConnectPopup() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) {
      setOpen(false);
      return;
    }
    if (alreadySeen(user.id)) return;
    // A short delay so the popup does not fight the page it is landing on.
    const timer = window.setTimeout(() => setOpen(true), 600);
    return () => window.clearTimeout(timer);
  }, [user]);

  if (!open || !user) return null;

  function close() {
    if (user) remember(user.id);
    setOpen(false);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect your AI assistant"
        className="glass max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-2xl font-bold tracking-tight text-white">
              Connect your AI assistant
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              Ship-It speaks the Model Context Protocol, so one server works with Claude, Codex,
              Cursor and the rest. Paste the snippet for your client — then ask your agent to
              log in, and it opens a Ship-It page for you to approve.
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-sm text-zinc-400 transition-colors hover:border-white/25 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="mt-5">
          <ConnectTabs compact />
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <a
            href="/docs"
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Read the documentation
          </a>
          <button
            type="button"
            onClick={close}
            className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
