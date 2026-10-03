import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "@/components/site/Modal";

interface BuildLog {
  stream: string;
  content: string;
  created_at: string;
}

const STREAM_TONE: Record<string, string> = {
  stdout: "text-zinc-300",
  stderr: "text-rose-300",
  system: "text-zinc-500",
};

// Tabs above this many lines: without them a failed build is a single wall of
// text with the actual error somewhere in the middle.
const MAX_TABS = 400;

export function BuildLogViewer({
  buildId,
  githubRunUrl,
  onClose,
}: {
  buildId: string;
  githubRunUrl?: string | null;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<BuildLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await api.get<{ logs: BuildLog[] }>(
          `/api/v1/builds/${buildId}/logs`,
        );
        if (!cancelled) {
          setLogs(res.logs);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load build logs",
          );
        }
      }
    };

    load();
    // Builds still running gain log lines over time, so keep polling while open.
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [buildId]);

  useEffect(() => {
    if (!follow) return;
    const scroller = document.getElementById("build-log-scroller");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [logs, follow]);

  const needle = filter.trim().toLowerCase();
  const visible = (logs ?? []).filter((line) =>
    needle ? line.content.toLowerCase().includes(needle) : true,
  );
  const hidden = (logs?.length ?? 0) - visible.length;

  return (
    <Modal
      title={buildId}
      description={
        githubRunUrl ? (
          <span>
            Build output ·{" "}
            <a
              href={githubRunUrl}
              target="_blank"
              rel="noreferrer"
              className="text-violet-400 transition-colors hover:text-violet-300"
            >
              View GitHub Actions run
            </a>
          </span>
        ) : (
          "Build output"
        )
      }
      onClose={onClose}
      width="max-w-5xl"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter output"
          aria-label="Filter build output"
          className="w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
        />
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            className="accent-violet-500"
          />
          Follow output
        </label>
      </div>

      {error ? (
        <p className="text-sm text-rose-300">{error}</p>
      ) : logs === null ? (
        <p className="text-sm text-zinc-500">Loading output...</p>
      ) : logs.length === 0 ? (
        <div className="text-sm text-zinc-500">
          <p>
            No output has been reported for this build yet.
          </p>
          {githubRunUrl ? (
            <p className="mt-3">
              <a
                href={githubRunUrl}
                target="_blank"
                rel="noreferrer"
                className="text-violet-300 transition-colors hover:text-violet-200"
              >
                Read the output in the GitHub Actions run
              </a>
            </p>
          ) : (
            <p className="mt-3">
              Builds that run on GitHub Actions publish their output once the
              run finishes.
            </p>
          )}
        </div>
      ) : (
        <>
          {hidden > 0 && (
            <p className="mb-3 text-xs text-amber-300/90">
              {hidden} of {logs.length} lines hidden by the filter.
            </p>
          )}
          <div
            id="build-log-scroller"
            className="max-h-[60vh] overflow-auto rounded-xl border border-white/[0.07] bg-black/40"
          >
            <pre className="min-w-full p-4 font-mono text-xs leading-relaxed">
              {visible.slice(-MAX_TABS).map((line, index) => (
                <div
                  key={`${line.created_at}-${index}`}
                  className={`whitespace-pre-wrap break-all ${
                    STREAM_TONE[line.stream] ?? "text-zinc-300"
                  }`}
                >
                  {line.content}
                </div>
              ))}
            </pre>
          </div>
          {logs.length > MAX_TABS && (
            <p className="mt-3 text-xs text-zinc-600">
              Showing the last {MAX_TABS} of {logs.length} lines.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
