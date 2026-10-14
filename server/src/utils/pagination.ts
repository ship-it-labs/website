import { supabase, usingSqlite } from "../db/index.js";

/**
 * Page-number pagination shared by every list endpoint.
 *
 * Query: `?page=1&limit=25` (both optional). Response shape:
 * `{ items, total, page, limit }` — or the endpoint's legacy key (e.g.
 * `projects`) alongside `total/page/limit` where a shipped client already
 * reads that key.
 *
 * Two backends, one code path: the page itself uses `.range()`, which the
 * node:sqlite driver now implements and PostgREST speaks natively. Totals
 * come from a head-count on Supabase (`{count:"exact", head:true}` fetches no
 * rows) and from an id-only select on sqlite, where tables are small and a
 * second indexed query is cheaper than teaching the local driver count
 * semantics nobody else needs.
 */

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export interface PageParams {
  page: number;
  limit: number;
  offset: number;
}

export function parsePageParams(query: unknown): PageParams {
  const q = (query ?? {}) as Record<string, unknown>;
  let page = Math.floor(Number(q.page));
  let limit = Math.floor(Number(q.limit));
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_PAGE_LIMIT;
  if (limit > MAX_PAGE_LIMIT) limit = MAX_PAGE_LIMIT;
  return { page, limit, offset: (page - 1) * limit };
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** Applies endpoint-specific filters (eq/like/in/...) to a query builder.
 * Typed loosely on purpose: the Supabase and sqlite builders share the
 * filter vocabulary but not a type. */
export type FilterFn = (q: any) => any;

export async function paginateTable<T>(options: {
  table: string;
  columns: string;
  orderBy: string;
  ascending?: boolean;
  page: PageParams;
  applyFilters?: FilterFn;
}): Promise<{ items: T[]; total: number }> {
  const { table, columns, orderBy, ascending = false, page, applyFilters } = options;
  const from = page.offset;
  const to = page.offset + page.limit - 1;

  let pq: any = supabase.from(table).select(columns);
  if (applyFilters) pq = applyFilters(pq);
  pq = pq.order(orderBy, { ascending }).range(from, to);
  const { data, error } = await pq;
  if (error) throw new Error(error.message ?? "paged query failed");
  const items = (data ?? []) as T[];

  let total: number;
  if (usingSqlite) {
    let cq: any = supabase.from(table).select("id");
    if (applyFilters) cq = applyFilters(cq);
    const { data: rows, error: countError } = await cq;
    if (countError) throw new Error(countError.message ?? "paged count failed");
    total = (rows ?? []).length;
  } else {
    const client = supabase as unknown as { from: (t: string) => any };
    let cq: any = client.from(table).select("*", { count: "exact", head: true });
    if (applyFilters) cq = applyFilters(cq);
    const { count, error: countError } = await cq;
    if (countError) throw new Error(countError.message ?? "paged count failed");
    total = typeof count === "number" ? count : items.length;
  }

  return { items, total };
}

/** Wraps a page in the standard envelope. */
export function pageEnvelope<T>(items: T[], total: number, page: PageParams): PagedResult<T> {
  return { items, total, page: page.page, limit: page.limit };
}
