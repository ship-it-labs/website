import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api";
import {
  agentApi,
  newMessageId,
  type AgentConversation,
  type AgentMessage,
  type AgentStatus,
} from "@/lib/agent";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The signed-in assistant, as a floating panel bottom-right. It only exists for
 * an authenticated user (the server rejects anonymous callers anyway), loads the
 * most recent thread on first open, and keeps every thread server-side so a
 * refresh or another device shows the same conversation.
 *
 * The panel has three faces: the chat, the list of past threads, and a direct
 * report form for when the user just wants to file something without talking to
 * the model first.
 */

const EXAMPLES = [
  "What plan am I on and how much time is left?",
  "Why did my last build fail?",
  "How do I deploy from OpenCode?",
];

function friendly(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}

export function AssistantWidget() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"chat" | "history" | "report">("chat");

  const [reportSummary, setReportSummary] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportState, setReportState] = useState<"idle" | "busy" | "done">("idle");

  const listRef = useRef<HTMLDivElement>(null);
  const bootstrapped = useRef(false);

  const loadConversations = useCallback(async (): Promise<AgentConversation[]> => {
    try {
      const { conversations: list } = await agentApi.conversations();
      setConversations(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await agentApi.conversation(id);
      setActiveId(data.id);
      setMessages(data.messages);
      setPanel("chat");
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // Load status and the most recent thread once, the first time the panel opens.
  useEffect(() => {
    if (!open || bootstrapped.current || !user) return;
    bootstrapped.current = true;
    void (async () => {
      try {
        const result = await agentApi.status();
        setStatus(result);
        if (!result.enabled) return;
        const list = await loadConversations();
        if (list.length > 0) await openConversation(list[0].id);
      } catch {
        // A failing status check is not fatal; the composer surfaces real errors.
      }
    })();
  }, [open, user, loadConversations, openConversation]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  if (loading || !user) return null;

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setInput("");
    setError(null);
    setMessages((prev) => [
      ...prev,
      {
        id: newMessageId(),
        role: "user",
        content: clean,
        model: null,
        cacheHit: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    setBusy(true);
    try {
      const turn = await agentApi.send(clean, activeId);
      setActiveId(turn.conversationId);
      setMessages((prev) => [
        ...prev,
        {
          id: newMessageId(),
          role: "assistant",
          content: turn.reply,
          model: turn.model,
          cacheHit: turn.cacheHit,
          createdAt: new Date().toISOString(),
        },
      ]);
      void loadConversations();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeConversation(id: string) {
    try {
      await agentApi.remove(id);
      const list = await loadConversations();
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setPanel("chat");
        if (list.length > 0) await openConversation(list[0].id);
      }
    } catch (err) {
      setError(friendly(err));
    }
  }

  async function submitReport() {
    const summary = reportSummary.trim();
    if (summary.length < 3 || reportState === "busy") return;
    setReportState("busy");
    setError(null);
    try {
      await agentApi.report(summary, reportDetails.trim());
      setReportState("done");
    } catch (err) {
      setError(friendly(err));
      setReportState("idle");
    }
  }

  function startNewChat() {
    setActiveId(null);
    setMessages([]);
    setError(null);
    setPanel("chat");
  }

  const disabled = status ? !status.enabled : false;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Open the Ship-It assistant"
        className={cn(
          "fixed bottom-4 right-24 z-50 rounded-full border border-white/10 bg-zinc-900/90 px-4 py-2.5 text-xs font-medium text-zinc-200 shadow-xl backdrop-blur-xl transition-all hover:border-violet-400/50 hover:text-white",
          open && "border-violet-400/50 text-white"
        )}
      >
        Ask AI
      </button>

      {open && (
        <div className="fixed bottom-4 right-4 z-50 flex h-[min(640px,calc(100vh-2rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 shadow-2xl backdrop-blur-2xl">
          <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">Ship-It Assistant</p>
              <p className="truncate text-[11px] text-zinc-500">
                {disabled
                  ? "Temporarily unavailable"
                  : messages.length > 0
                    ? "Knows your account, builds and docs"
                    : "Ask about your account or how something works"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanel(panel === "history" ? "chat" : "history")}
              className="rounded-lg px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              {panel === "history" ? "Back" : "Chats"}
            </button>
            <button
              type="button"
              onClick={() => setPanel(panel === "report" ? "chat" : "report")}
              className="rounded-lg px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              Report
            </button>
            <button
              type="button"
              onClick={startNewChat}
              className="rounded-lg px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              New
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              ×
            </button>
          </header>

          {disabled ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-400">
              The assistant is offline right now. You can still send a report and a
              human will pick it up.
            </div>
          ) : panel === "history" ? (
            <div className="flex-1 overflow-y-auto p-2">
              {conversations.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">No conversations yet.</p>
              ) : (
                <ul className="space-y-1">
                  {conversations.map((conversation) => (
                    <li key={conversation.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void openConversation(conversation.id)}
                        className={cn(
                          "min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-white/5",
                          conversation.id === activeId && "bg-white/[0.06]"
                        )}
                      >
                        <span className="block truncate text-sm text-zinc-200">
                          {conversation.title}
                        </span>
                        <span className="block text-[11px] text-zinc-500">
                          {timeAgo(conversation.updatedAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeConversation(conversation.id)}
                        aria-label={`Delete ${conversation.title}`}
                        className="rounded-lg px-2 py-2 text-xs text-zinc-600 hover:text-rose-300"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : panel === "report" ? (
            <div className="flex-1 overflow-y-auto p-4">
              {reportState === "done" ? (
                <div className="space-y-3">
                  <p className="text-sm text-emerald-300">
                    Report filed. The team will see it attached to your account.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setReportState("idle");
                      setReportSummary("");
                      setReportDetails("");
                      setPanel("chat");
                    }}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-zinc-950"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <input
                    value={reportSummary}
                    onChange={(event) => setReportSummary(event.target.value)}
                    placeholder="Summary (what is wrong?)"
                    maxLength={200}
                    className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                  />
                  <textarea
                    value={reportDetails}
                    onChange={(event) => setReportDetails(event.target.value)}
                    placeholder="What were you doing and what happened?"
                    rows={5}
                    maxLength={1800}
                    className="w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void submitReport()}
                    disabled={reportState === "busy" || reportSummary.trim().length < 3}
                    className="w-full rounded-xl bg-white px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-60"
                  >
                    {reportState === "busy" ? "Filing…" : "File report"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 && (
                  <div className="space-y-3">
                    <p className="text-sm text-zinc-400">
                      Ask anything about your account or the platform. I can see your
                      plan, projects, builds and the docs.
                    </p>
                    <div className="flex flex-col gap-2">
                      {EXAMPLES.map((example) => (
                        <button
                          key={example}
                          type="button"
                          onClick={() => void send(example)}
                          className="rounded-xl border border-white/10 px-3 py-2 text-left text-xs text-zinc-300 hover:border-violet-400/40 hover:text-white"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm",
                      message.role === "user"
                        ? "ml-auto border border-violet-400/30 bg-violet-500/15 text-violet-50"
                        : "border border-white/10 bg-white/[0.04] text-zinc-200"
                    )}
                  >
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    {message.role === "assistant" && (message.model || message.cacheHit) && (
                      <p className="mt-1 text-[10px] text-zinc-600">
                        {message.model}
                        {message.cacheHit ? " · cached" : ""}
                      </p>
                    )}
                  </div>
                ))}

                {busy && <p className="text-xs text-zinc-500">Thinking…</p>}
              </div>

              {error && (
                <p className="border-t border-white/10 px-4 py-2 text-xs text-rose-300">{error}</p>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(input);
                }}
                className="flex items-end gap-2 border-t border-white/10 p-3"
              >
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send(input);
                    }
                  }}
                  placeholder="Ask the assistant…"
                  rows={1}
                  maxLength={4000}
                  className="max-h-32 min-h-[44px] flex-1 resize-y rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition-transform hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
                >
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}
