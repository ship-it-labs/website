import { useState } from "react";
import { CopyButton } from "@/components/site/CopyButton";
import { CONNECT_CLIENTS } from "@/lib/connect-clients";
import { cn } from "@/lib/utils";

/**
 * How to connect an AI client to Ship-It.
 *
 * Every modern MCP client speaks the same protocol, so the only thing that
 * differs is where the client keeps its server list. The tabs below are that
 * list, per client, with the snippet ready to paste.
 */

const MCP_URL_PATH = "/mcp";

function mcpUrl(): string {
  if (typeof window === "undefined") return MCP_URL_PATH;
  return `${window.location.origin}${MCP_URL_PATH}`;
}

export function ConnectTabs({ compact = false }: { compact?: boolean }) {
  const [active, setActive] = useState(CONNECT_CLIENTS[0].id);
  const client = CONNECT_CLIENTS.find((entry) => entry.id === active) ?? CONNECT_CLIENTS[0];
  const snippet = client.snippet(mcpUrl());

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Clients">
        {CONNECT_CLIENTS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === active}
            onClick={() => setActive(entry.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-200",
              entry.id === active
                ? "bg-white/[0.09] text-white"
                : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {entry.name}
            {entry.deprecated && <span className="ml-1.5 text-[10px] text-amber-400/80">deprecated</span>}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <p className="font-mono text-[11px] uppercase tracking-widest text-violet-300/80">
          {client.location}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{client.summary}</p>

        <div className="mt-3 flex items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-4">
          <pre className="flex-1 overflow-x-auto text-[12.5px] leading-relaxed">
            <code className="text-zinc-300">{snippet}</code>
          </pre>
          <CopyButton text={snippet} />
        </div>

        {client.note && !compact && (
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">{client.note}</p>
        )}
      </div>
    </div>
  );
}
