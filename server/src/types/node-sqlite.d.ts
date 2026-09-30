/**
 * node:sqlite ships in Node 22.5+ but @types/node has not declared it for every
 * supported version, so the surface this codebase uses is declared here.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
