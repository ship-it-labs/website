import crypto from "node:crypto";
import { DatabaseSync, type SqliteDatabase } from "./binding.js";
import fs from "node:fs";
import path from "node:path";
import { TableQuery, type QueryResult } from "./query.js";
import { SCHEMA_SQL, SEED_PLANS_SQL, applyMigrations } from "./schema.js";

export interface LocalAuthUser {
  id: string;
  email: string;
}

const AUTH_SCHEMA_SQL = `
create table if not exists auth_users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  created_at text not null default (datetime('now'))
);

create table if not exists auth_sessions (
  token text primary key,
  user_id text not null references auth_users(id) on delete cascade,
  expires_at text not null,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_auth_sessions_user on auth_sessions(user_id);
`;

/**
 * A local stand-in for the Supabase client backed by node:sqlite and the
 * filesystem. It implements the same calls the services use, so development
 * needs no Postgres, no PostgREST, no Supabase Auth and no network.
 */
export class SqliteClient {
  private readonly db: SqliteDatabase;
  readonly storageRoot: string;
  private readonly publicBaseUrl: string;
  private readonly internalBaseUrl: string | null;

  constructor(options: {
    file: string;
    storageRoot: string;
    publicBaseUrl: string;
    /**
     * Address other services in the private network use to reach this one. A
     * signed URL built for them must not point at a public hostname they cannot
     * resolve, such as 127.0.0.1 from inside a container.
     */
    internalBaseUrl?: string;
  }) {
    const dir = path.dirname(options.file);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(options.file);
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma foreign_keys = on");
    this.storageRoot = options.storageRoot;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    this.internalBaseUrl = options.internalBaseUrl
      ? options.internalBaseUrl.replace(/\/+$/, "")
      : null;

    this.db.exec(SCHEMA_SQL);
    applyMigrations(this.db);
    this.db.exec(SEED_PLANS_SQL);
    this.db.exec(AUTH_SCHEMA_SQL);
  }

  from(table: string): TableQuery {
    return new TableQuery(this.db, table);
  }

  /**
   * Replaces the two Postgres functions used for usage accounting with the
   * equivalent SQLite statements.
   */
  async rpc(
    name: string,
    params: Record<string, unknown>
  ): Promise<{ data: null; error: { message: string; code?: string } | null }> {
    try {
      switch (name) {
        case "increment_runtime_usage": {
          this.db
            .prepare(
              `insert into usage_months (user_id, period_start, period_end, runtime_used_seconds)
               values (?, ?, ?, ?)
               on conflict(user_id, period_start) do update set
                 runtime_used_seconds = runtime_used_seconds + excluded.runtime_used_seconds`
            )
            .run(
              String(params.p_user_id),
              String(params.p_period_start),
              String(params.p_period_end),
              Number(params.p_seconds ?? 0)
            );
          break;
        }

        case "increment_build_count": {
          this.db
            .prepare(
              `insert into usage_months (user_id, period_start, period_end, build_count)
               values (?, ?, ?, 1)
               on conflict(user_id, period_start) do update set
                 build_count = build_count + 1`
            )
            .run(
              String(params.p_user_id),
              String(params.p_period_start),
              String(params.p_period_end)
            );
          break;
        }

        default:
          return { data: null, error: { message: `Unknown rpc: ${name}` } };
      }

      return { data: null, error: null };
    } catch (err) {
      return {
        data: null,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /**
   * Local password auth, standing in for Supabase Auth. Passwords are hashed
   * with scrypt and a per-user salt, and sessions are opaque random tokens
   * stored in the database. This exists only so development has a working
   * login flow; production uses Supabase Auth.
   */
  get auth() {
    const db = this.db;

    const hashPassword = (password: string, salt: string): string =>
      crypto.scryptSync(password, salt, 64).toString("hex");

    const findByEmail = (email: string) =>
      db
        .prepare("select id, email, password_hash from auth_users where email = ?")
        .get(email.toLowerCase()) as
        | { id: string; email: string; password_hash: string }
        | undefined;

    return {
      signUp: async (params: { email: string; password: string }) => {
        const email = params.email.toLowerCase();
        if (findByEmail(email)) {
          return { data: null, error: { message: "User already registered" } };
        }

        const id = crypto.randomUUID();
        const salt = crypto.randomBytes(16).toString("hex");
        db.prepare(
          "insert into auth_users (id, email, password_hash) values (?, ?, ?)"
        ).run(id, email, `${salt}:${hashPassword(params.password, salt)}`);

        const session = this.createSession(id);
        return {
          data: { user: { id, email }, session },
          error: null,
        };
      },

      signInWithPassword: async (params: { email: string; password: string }) => {
        const record = findByEmail(params.email);
        if (!record) {
          return { data: null, error: { message: "Invalid login credentials" } };
        }

        const [salt, expected] = record.password_hash.split(":");
        const actual = hashPassword(params.password, salt);
        const a = Buffer.from(actual, "hex");
        const b = Buffer.from(expected, "hex");

        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return { data: null, error: { message: "Invalid login credentials" } };
        }

        return {
          data: { user: { id: record.id, email: record.email }, session: this.createSession(record.id) },
          error: null,
        };
      },

      signOut: async () => ({ error: null }),

      resetPasswordForEmail: async () => ({ data: {}, error: null }),

      // Sets a new password without knowing the old one: the route verifies
      // the current password first by signing in, so by the time this runs the
      // caller is proven to be the account holder.
      updatePassword: async (params: { id: string; password: string }) => {
        const row = db.prepare("select id from auth_users where id = ?").get(params.id) as
          | { id: string }
          | undefined;
        if (!row) return { data: null, error: { message: "User not found" } };

        const salt = crypto.randomBytes(16).toString("hex");
        db.prepare("update auth_users set password_hash = ? where id = ?").run(
          `${salt}:${hashPassword(params.password, salt)}`,
          params.id
        );
        return { data: { user: { id: params.id } }, error: null };
      },

      // Changes the login email. The public users row is synced by the route,
      // which owns the cross-table invariant in both drivers.
      updateEmail: async (params: { id: string; email: string }) => {
        const email = params.email.toLowerCase();
        const clash = db.prepare("select id from auth_users where email = ?").get(email) as
          | { id: string }
          | undefined;
        if (clash && clash.id !== params.id) {
          return { data: null, error: { message: "That email is already registered" } };
        }
        db.prepare("update auth_users set email = ? where id = ?").run(email, params.id);
        return { data: { user: { id: params.id, email } }, error: null };
      },

      // Deletes the credential row; auth_sessions cascade. The route deletes
      // the public users row separately, which cascades the application data.
      deleteUser: async (params: { id: string }) => {
        db.prepare("delete from auth_users where id = ?").run(params.id);
        return { data: null, error: null };
      },

      getSession: async () => ({ data: { session: null }, error: null }),

      getUser: async (params: { id?: string }) => {
        const id = params?.id ?? this.sessionUserId;
        if (!id) return { data: { user: null }, error: null };
        const row = db.prepare("select id, email from auth_users where id = ?").get(id) as
          | { id: string; email: string }
          | undefined;
        return { data: { user: row ?? null }, error: null };
      },
    };
  }

  /** Resolves a bearer token to the user id it was issued for. */
  getUserIdForToken(token: string): string | null {    const row = this.db
      .prepare("select user_id, expires_at from auth_sessions where token = ?")
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row.user_id;
  }

  /** Drops one local session token. Unknown tokens are a no-op, so revoking
   * twice or revoking after expiry stays quiet instead of erroring. */
  revokeLocalSession(token: string): void {
    this.db.prepare("delete from auth_sessions where token = ?").run(token);
  }

  /** Drops every local session for a user except the one still in use, so
   * "sign out everywhere" ends other devices immediately rather than at the
   * seven-day expiry. */
  revokeOtherLocalSessions(userId: string, exceptToken: string): void {
    this.db
      .prepare("delete from auth_sessions where user_id = ? and token != ?")
      .run(userId, exceptToken);
  }

  /**
   * Runs raw SQL for the admin database console. Development only: there is
   * no equivalent on Supabase, where PostgREST cannot execute arbitrary
   * statements. SELECT-like input returns capped rows; anything else executes
   * and reports back without a result set.
   */
  execRaw(sql: string): { columns: string[]; rows: Record<string, unknown>[] } {
    const head = sql.trim().toLowerCase();
    if (
      head.startsWith("select") ||
      head.startsWith("with") ||
      head.startsWith("explain") ||
      head.startsWith("pragma")
    ) {
      const rows = this.db.prepare(sql).all() as Record<string, unknown>[];
      const capped = rows.slice(0, 200);
      return { columns: capped.length > 0 ? Object.keys(capped[0]) : [], rows: capped };
    }

    this.db.exec(sql);
    return { columns: [], rows: [] };
  }

  private sessionUserId: string | null = null;

  private createSession(userId: string) {
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    this.db
      .prepare("insert into auth_sessions (token, user_id, expires_at) values (?, ?, ?)")
      .run(token, userId, expires);

    this.sessionUserId = userId;

    return {
      access_token: token,
      refresh_token: token,
      expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      user: { id: userId },
    };
  }

  get storage() {
    const root = this.storageRoot;
    const base = this.publicBaseUrl;
    const internalBase = this.internalBaseUrl;

    return {
      from: (bucket: string) => ({
        upload: async (
          objectPath: string,
          body: Buffer | Uint8Array,
          _options?: { contentType?: string; upsert?: boolean }
        ): Promise<{ data: null; error: { message: string } | null }> => {
          try {
            const target = path.join(root, bucket, objectPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, body);
            return { data: null, error: null };
          } catch (err) {
            return {
              data: null,
              error: { message: err instanceof Error ? err.message : String(err) },
            };
          }
        },

        /**
         * Local development has no signing service, so the URL is a plain path
         * served by this same process. The build workflow still verifies the
         * SHA-256 checksum, so the integrity guarantee is unchanged.
         */
        /**
         * Signs the path exactly as it appears in the URL, bucket included, so
         * the local-storage route can verify the request it receives without
         * having to guess how the caller built it. Signing the object path alone
         * produced links that were rejected with a bad signature.
         */
        createSignedUrl: async (
          objectPath: string,
          ttlSeconds: number,
          options?: { audience?: "public" | "internal" }
        ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> => {
          const target = path.join(root, bucket, objectPath);
          if (!fs.existsSync(target)) {
            return { data: null, error: { message: "Object not found" } };
          }

          const relative = `${bucket}/${objectPath.replace(/^\/+/, "")}`;
          const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
          const token = crypto
            .createHmac("sha256", process.env.API_KEY_HASH_SECRET ?? "dev")
            .update(`${relative}:${expires}`)
            .digest("hex")
            .slice(0, 32);

          // Services inside the private network fetch through the internal
          // address. Outside development there is one reachable hostname and the
          // internal base is unset, so both audiences get the same URL.
          const audienceBase =
            options?.audience === "internal" && internalBase ? internalBase : base;

          return {
            data: {
              signedUrl: `${audienceBase}/local-storage/${relative}?expires=${expires}&token=${token}`,
            },
            error: null,
          };
        },

        remove: async (objectPath: string) => {
          const target = path.join(root, bucket, objectPath);
          if (fs.existsSync(target)) fs.rmSync(target);
          return { data: null, error: null };
        },
      }),
    };
  }

  close(): void {
    this.db.close();
  }
}

export type { QueryResult };
