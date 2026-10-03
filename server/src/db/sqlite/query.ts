import { DatabaseSync, type SqliteDatabase } from "./binding.js";
import fs from "node:fs";
import path from "node:path";

export interface DbError {
  message: string;
  code?: string;
  details?: string;
}

export interface QueryResult<T = any> {
  data: T | null;
  error: DbError | null;
}

type Condition = [column: string, op: string, value: unknown];

const OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
  ilike: "LIKE",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * A minimal query builder that mirrors the slice of the supabase-js API this
 * codebase uses. Development runs on node:sqlite so the platform boots with no
 * external services; production uses the real Supabase client.
 */
class TableQuery implements PromiseLike<QueryResult> {
  private mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conditions: Condition[] = [];
  private orderColumn: string | null = null;
  private orderAscending = true;
  private limitCount: number | null = null;
  private singleMode = false;
  private conflictTarget: string | null = null;
  private returningColumns: string | null = null;
  private returning = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly table: string
  ) {}

  select(columns?: string): this {
    // select() after insert() means "return the inserted rows", mirroring
    // PostgREST. Any other mode keeps its own behaviour.
    if (this.mode === "insert") {
      this.returningColumns = columns ?? "*";
      this.returning = true;
      return this;
    }
    if (this.mode === "select" || this.mode === "delete") {
      this.mode = "select";
      this.returningColumns = columns ?? "*";
    }
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[]): this {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  upsert(
    payload: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string }
  ): this {
    this.mode = "upsert";
    this.payload = payload;
    this.conflictTarget = options?.onConflict ?? null;
    return this;
  }

  update(payload: Record<string, unknown>): this {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.mode = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.condition(column, "eq", value);
  }
  neq(column: string, value: unknown): this {
    return this.condition(column, "neq", value);
  }
  lt(column: string, value: unknown): this {
    return this.condition(column, "lt", value);
  }
  lte(column: string, value: unknown): this {
    return this.condition(column, "lte", value);
  }
  gt(column: string, value: unknown): this {
    return this.condition(column, "gt", value);
  }
  gte(column: string, value: unknown): this {
    return this.condition(column, "gte", value);
  }
  like(column: string, value: unknown): this {
    return this.condition(column, "like", value);
  }

  /** Matches any of the supplied values, matching Supabase's `.in`. */
  in(column: string, values: readonly unknown[]): this {
    return this.condition(column, "in", values);
  }

  /** True when none of the supplied values match, matching Supabase's `.not.in`. */
  notIn(column: string, values: readonly unknown[]): this {
    return this.condition(column, "not_in", values);
  }

  private condition(column: string, op: string, value: unknown): this {
    this.conditions.push([column, op, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.singleMode = true;
    return this;
  }

  maybeSingle(): this {
    this.singleMode = true;
    return this;
  }

  then<R1 = QueryResult, R2 = never>(
    onfulfilled?: ((value: QueryResult) => PromiseLike<R1> | R1) | null,
    onrejected?: ((reason: unknown) => PromiseLike<R2> | R2) | null
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private execute(): Promise<QueryResult> {
    try {
      switch (this.mode) {
        case "insert":
          return Promise.resolve(this.runInsert(false));
        case "upsert":
          return Promise.resolve(this.runInsert(true));
        case "update":
          return Promise.resolve(this.runUpdate());
        case "delete":
          return Promise.resolve(this.runDelete());
        default:
          return Promise.resolve(this.runSelect());
      }
    } catch (err) {
      return Promise.resolve({
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private buildWhere(values: unknown[]): string {
    if (this.conditions.length === 0) return "";
    const clauses = this.conditions.map(([column, op, value]) => {
      // Set membership expands to one placeholder per value, which is why it
      // cannot go through the single-value path above.
      if (op === "in" || op === "not_in") {
        const items = Array.isArray(value) ? value : [value];
        if (items.length === 0) {
          // An empty set can match nothing, so it is written as a condition that
          // is always false rather than as invalid SQL.
          return op === "in" ? "1 = 0" : "1 = 1";
        }
        const placeholders = items.map((item) => {
          values.push(item);
          return "?";
        });
        const keyword = op === "in" ? "in" : "not in";
        return `${quoteIdent(column)} ${keyword} (${placeholders.join(", ")})`;
      }

      values.push(value);
      return `${quoteIdent(column)} ${OPERATORS[op]} ?`;
    });
    return ` where ${clauses.join(" and ")}`;
  }

  private runSelect(): QueryResult {
    const values: unknown[] = [];
    const columns = this.returningColumns && this.returningColumns !== "*"
      ? this.returningColumns
          .split(",")
          .map((c) => quoteIdent(c.trim()))
          .join(", ")
      : "*";

    let sql = `select ${columns} from ${quoteIdent(this.table)}${this.buildWhere(values)}`;

    if (this.orderColumn) {
      sql += ` order by ${quoteIdent(this.orderColumn)} ${this.orderAscending ? "asc" : "desc"}`;
    }
    if (this.limitCount !== null) {
      sql += ` limit ${Number(this.limitCount)}`;
    } else if (this.singleMode) {
      sql += " limit 2";
    }

    const raw = this.db.prepare(sql).all(...(values as never[])) as Record<string, unknown>[];
    const rows = raw.map(revive);

    if (this.singleMode) {
      if (rows.length === 0) {
        return { data: null, error: { message: "No rows found", code: "PGRST116" } };
      }
      return { data: rows[0], error: null };
    }

    return { data: rows, error: null };
  }

  private runInsert(isUpsert: boolean): QueryResult {
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];

    const insertOne = (row: Record<string, unknown>): void => {
      const keys = Object.keys(row);
      if (keys.length === 0) return;

      const columns = keys.map(quoteIdent).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const values = keys.map((key) => normalise(row[key]));

      let sql = `insert into ${quoteIdent(this.table)} (${columns}) values (${placeholders})`;

      if (isUpsert) {
        // SQLite has no ON CONFLICT DO UPDATE with a dynamic target, so an
        // upsert is expressed as insert-or-ignore followed by an update.
        sql += " on conflict do nothing";
      }

      this.db.prepare(sql).run(...(values as never[]));

      if (isUpsert) {
        // `excluded` only exists inside an INSERT ... ON CONFLICT clause, so the
        // follow-up update binds the values directly.
        const conflict = this.conflictTarget ?? keys[0];
        const updatable = keys.filter((key) => key !== conflict);

        if (updatable.length > 0) {
          const assignments = updatable.map((key) => `${quoteIdent(key)} = ?`);
          const values = updatable.map((key) => normalise(row[key]));

          this.db
            .prepare(
              `update ${quoteIdent(this.table)} set ${assignments.join(", ")} where ${quoteIdent(
                conflict
              )} = ?`
            )
            .run(...([...values, normalise(row[conflict])] as never[]));
        }
      }
    };

    for (const row of rows) {
      insertOne(row);
    }

    if (!this.returning) {
      return { data: null, error: null };
    }

    // Return the inserted rows in input order, honouring single() and limit().
    const keys = Object.keys(rows[0] ?? {});
    const idValues = rows.map((row) => normalise(row[keys[0]]));
    const placeholders = idValues.map(() => "?").join(", ");
    const columns =
      this.returningColumns && this.returningColumns !== "*"
        ? this.returningColumns
            .split(",")
            .map((c) => quoteIdent(c.trim()))
            .join(", ")
        : "*";

    const selected = this.db
      .prepare(
        `select ${columns} from ${quoteIdent(this.table)} where ${quoteIdent(keys[0])} in (${placeholders})`
      )
      .all(...(idValues as never[])) as Record<string, unknown>[];

    const ordered = idValues
      .map((id) => selected.find((row) => revive(row)[keys[0]] === id))
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .map(revive);

    if (this.singleMode) {
      if (ordered.length === 0) {
        return { data: null, error: { message: "No rows found", code: "PGRST116" } };
      }
      return { data: ordered[0], error: null };
    }

    const limited =
      this.limitCount !== null ? ordered.slice(0, this.limitCount) : ordered;
    return { data: limited, error: null };
  }

  private runUpdate(): QueryResult {
    const row = (this.payload ?? {}) as Record<string, unknown>;
    const keys = Object.keys(row);

    if (keys.length === 0) {
      return { data: null, error: null };
    }

    const values = keys.map((key) => normalise(row[key]));
    const assignments = keys.map((key) => `${quoteIdent(key)} = ?`).join(", ");

    const whereValues: unknown[] = [];
    const where = this.buildWhere(whereValues);

    this.db
      .prepare(`update ${quoteIdent(this.table)} set ${assignments}${where}`)
      .run(...([...values, ...whereValues] as never[]));

    return { data: null, error: null };
  }

  private runDelete(): QueryResult {
    const values: unknown[] = [];
    const where = this.buildWhere(values);
    this.db.prepare(`delete from ${quoteIdent(this.table)}${where}`).run(...(values as never[]));
    return { data: null, error: null };
  }
}

/** SQLite has no boolean or JSON column type, so values are stored as text. */
function normalise(value: unknown): unknown {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/** Booleans and JSON come back as strings and need converting on the way out. */
function revive(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && (value === "true" || value === "false")) {
      out[key] = value === "true";
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { TableQuery, revive };
