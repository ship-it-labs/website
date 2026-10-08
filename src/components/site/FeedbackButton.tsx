import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/site/Modal";

/**
 * Floating feedback entry point, bottom-right on every page that renders it.
 * One tap opens a small form; sending posts to the account endpoint, and the
 * admin panel owns the inbox. Nothing here needs auth state: the API rejects
 * anonymous callers, and the button simply hides its success behind a thanks.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/feedback", { message: message.trim() });
      setSent(true);
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send feedback");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setError(null);
    setSent(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        className="fixed bottom-4 right-4 z-50 rounded-full border border-white/10 bg-zinc-900/90 px-4 py-2.5 text-xs font-medium text-zinc-300 shadow-xl backdrop-blur-xl transition-all hover:border-white/25 hover:text-white"
      >
        Feedback
      </button>
      {open && (
        <Modal title="Send feedback" description="Bugs, confusion, wishes — it all lands in front of a human." onClose={close}>
          {sent ? (
            <div>
              <p className="text-sm text-emerald-300">Thanks — got it.</p>
              <button
                type="button"
                onClick={close}
                className="mt-4 rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="What happened, or what should exist?"
                rows={4}
                maxLength={2000}
                autoFocus
                className="w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
              />
              {error && <p className="text-sm text-rose-300">{error}</p>}
              <button
                type="submit"
                disabled={busy || !message.trim()}
                className="w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
              >
                {busy ? "Sending…" : "Send"}
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
