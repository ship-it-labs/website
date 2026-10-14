interface PaginationProps {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}

/**
 * Page-number pager for the paginated list endpoints (`?page=&limit=`).
 * Renders nothing for a single page so short lists stay visually unchanged.
 * The window shows the current page ±2 with first/last jumps, which stays
 * compact even at hundreds of pages.
 */
export function Pagination({ page, limit, total, onPage }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  if (pages <= 1) return null;

  const go = (p: number) => {
    const next = Math.min(pages, Math.max(1, p));
    if (next !== page) onPage(next);
  };

  const numbers: (number | "…")[] = [];
  const window = 2;
  let last = 0;
  for (let p = 1; p <= pages; p++) {
    const edge = p === 1 || p === pages;
    const near = Math.abs(p - page) <= window;
    if (!edge && !near) continue;
    if (p - last > 1) numbers.push("…");
    numbers.push(p);
    last = p;
  }

  const btn =
    "rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40";

  return (
    <nav aria-label="Pagination" className="mt-5 flex flex-wrap items-center gap-2">
      <button type="button" disabled={page <= 1} onClick={() => go(page - 1)} className={btn}>
        ← Prev
      </button>
      {numbers.map((n, i) =>
        n === "…" ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-zinc-600">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            disabled={n === page}
            onClick={() => go(n)}
            aria-current={n === page ? "page" : undefined}
            className={
              n === page
                ? "rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-1.5 text-xs font-medium text-white"
                : btn
            }
          >
            {n}
          </button>
        )
      )}
      <button type="button" disabled={page >= pages} onClick={() => go(page + 1)} className={btn}>
        Next →
      </button>
      <span className="ml-auto text-xs text-zinc-600">
        Page {page} of {pages} · {total} total
      </span>
    </nav>
  );
}
