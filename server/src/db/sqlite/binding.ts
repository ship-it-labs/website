import { createRequire } from "node:module";

/**
 * node:sqlite is loaded through createRequire rather than a static import.
 * Vite's SSR transform rewrites the `node:` prefix and then tries to resolve
 * `sqlite` from npm, which fails even though the builtin exists. Going through
 * require keeps the specifier intact in dev, in tests and in the build.
 */
const require = createRequire(import.meta.url);

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}

export interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (location: string, options?: { open?: boolean }) => SqliteDatabase;
}

const sqlite = require("node:sqlite") as SqliteModule;

export const DatabaseSync = sqlite.DatabaseSync;
