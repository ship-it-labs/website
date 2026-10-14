import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Fetches one page of a paginated list endpoint and holds the pager state.
 * `key` is the array field in the response (`sessions`, `grants`, `users`,
 * …); `total`/`page` fall back to the fetched length so unpaginated
 * responses degrade to a single page instead of crashing.
 */
export function usePaged<T>(path: string, key: string, limit = 10) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const body = await api.get<Record<string, unknown>>(
          `${path}?page=${p}&limit=${limit}`
        );
        const list = Array.isArray(body[key]) ? (body[key] as T[]) : [];
        setItems(list);
        setTotal(typeof body.total === "number" ? body.total : list.length);
        setPage(typeof body.page === "number" ? body.page : p);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the list");
      } finally {
        setLoading(false);
      }
    },
    [path, key, limit]
  );

  useEffect(() => {
    load(1);
  }, [load]);

  const goto = useCallback(
    (p: number) => {
      setPage(p);
      load(p);
    },
    [load]
  );

  const reload = useCallback(() => load(page), [load, page]);

  return { items, page, total, limit, loading, error, goto, reload };
}
