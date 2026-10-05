import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DbInfo {
  driver: "sqlite" | "supabase";
  raw_sql: boolean;
  tables: { name: string; description: string }[];
}

interface DbRows {
  table: string;
  rows: Record<string, unknown>[];
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return String(value);
}

/**
 * Database console. On development SQLite it runs raw SQL; on Supabase it
 * browses curated tables, because PostgREST cannot execute arbitrary
 * statements and pretending otherwise would be dishonest. Secret columns
 * (hashes, env values) are excluded server-side and can never appear here.
 */
export function DatabaseSection({ onError }: { onError: (message: string | null) => void }) {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [table, setTable] = useState("");
  const [rows, setRows] = useState<DbRows | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [sql, setSql] = useState("select id, email, plan_id, created_at from users order by created_at desc limit 20;");
  const [result, setResult] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmWrite, setConfirmWrite] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api.get<DbInfo>("/api/v1/admin/db");
      setInfo(state);
      if (!table && state.tables.length > 0) setTable(state.tables[0].name);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load database info");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function browse(name: string) {
    setTable(name);
    setLoadingRows(true);
    try {
      setRows(await api.get<DbRows>(`/api/v1/admin/db/rows?table=${encodeURIComponent(name)}&limit=50`));
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read the table");
    } finally {
      setLoadingRows(false);
    }
  }

  const isWrite = /^\s*(insert|update|delete|drop|alter|create|replace|vacuum|attach|detach|pragma)\b/i.test(sql);

  async function run() {
    if (!sql.trim()) return;
    setRunning(true);
    try {
      const out = await api.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
        "/api/v1/admin/db/query",
        { sql }
      );
      setResult(out);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setRunning(false);
      setConfirmWrite(false);
    }
  }

  if (!info) return <p className="text-sm text-zinc-500">Loading…</p>;

  const columns =
    result?.columns ??
    (rows && rows.rows.length > 0 ? Object.keys(rows.rows[0]) : []);
  const display = result?.rows ?? rows?.rows ?? [];

  return (
    <>
      <div className="glass mb-6 rounded-2xl">
        <div className="border-b border-white/[0.07] px-6 py-5">
          <h2 className="text-[15px] font-semibold text-white">Tables</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {info.driver === "sqlite"
              ? "Development database. Browse below, or run raw SQL underneath."
              : "Production database. Browse below — raw SQL is unavailable through the API, use the Supabase dashboard SQL editor for writes."}
          </p>
        </div>
        <div className="p-6">
          <div className="flex flex-wrap gap-2">
            {info.tables.map((entry) => (
              <button
                key={entry.name}
                type="button"
                onClick={() => browse(entry.name)}
                title={entry.description}
                className={`rounded-lg px-3.5 py-2 font-mono text-xs transition-colors ${
                  table === entry.name
                    ? "bg-white/[0.08] text-white"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {info.raw_sql && (
        <div className="glass mb-6 rounded-2xl">
          <div className="border-b border-white/[0.07] px-6 py-5">
            <h2 className="text-[15px] font-semibold text-white">Raw SQL</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Development only. Reads return up to 200 rows; writes execute
              immediately with no undo. Every execution is logged server-side.
            </p>
          </div>
          <div className="p-6">
            <textarea
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              rows={4}
              spellCheck={false}
              aria-label="SQL statement"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-200 focus:border-violet-500/60 focus:outline-none"
            />
            <div className="mt-3 flex items-center gap-3">
              {isWrite && !confirmWrite ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmWrite(true)}
                    className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
                  >
                    Review write
                  </button>
                  <span className="text-xs text-zinc-500">
                    This modifies data. Click again after reviewing the statement above.
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  disabled={running}
                  onClick={run}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
                >
                  {running ? "Running…" : isWrite ? "Confirm and run" : "Run query"}
                </button>
              )}
              {confirmWrite && (
                <button
                  type="button"
                  onClick={() => setConfirmWrite(false)}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="glass rounded-2xl">
        <div className="border-b border-white/[0.07] px-6 py-5">
          <h2 className="font-mono text-[15px] font-semibold text-white">
            {result ? "Query result" : table ? `Table: ${table}` : "Results"}
          </h2>
        </div>
        <div className="overflow-x-auto p-6">
          {loadingRows || running ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : display.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {table || result ? "No rows." : "Pick a table above, or run a query."}
            </p>
          ) : (
            <table className="w-full min-w-max border-collapse text-left font-mono text-xs">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="border-b border-white/[0.1] px-3 py-2 font-medium text-zinc-500"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {display.map((row, index) => (
                  <tr key={index} className="border-b border-white/[0.04] last:border-0">
                    {columns.map((column) => (
                      <td
                        key={column}
                        className="max-w-xs truncate px-3 py-2 text-zinc-300"
                        title={cell(row[column])}
                      >
                        {cell(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
