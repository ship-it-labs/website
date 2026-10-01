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

  constructor(options: { file: string; storageRoot: string; publicBaseUrl: string }) {
    const dir = path.dirname(options.file);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(options.file);
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma foreign_keys = on");
    this.storageRoot = options.storageRoot;
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");

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
  getUserIdForToken(token: string): string | null {
    const row = this.db
      .prepare("select user_id, expires_at from auth_sessions where token = ?")
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row.user_id;
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
        createSignedUrl: async (
          objectPath: string,
          ttlSeconds: number
        ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> => {
          const target = path.join(root, bucket, objectPath);
          if (!fs.existsSync(target)) {
            return { data: null, error: { message: "Object not found" } };
          }
          const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
          const token = crypto
            .createHmac("sha256", process.env.API_KEY_HASH_SECRET ?? "dev")
            .update(`${objectPath}:${expires}`)
            .digest("hex")
            .slice(0, 32);
          return {
            data: {
              signedUrl: `${base}/local-storage/${bucket}/${objectPath}?expires=${expires}&token=${token}`,
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
