import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "../src/db/sqlite/binding.js";
import { SCHEMA_SQL, applyMigrations } from "../src/db/sqlite/schema.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
});

afterEach(() => {
  db.close();
});

function columns(table: string): string[] {
  return (
    db.prepare(`pragma table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

function indexes(table: string): string[] {
  return (
    db
      .prepare(`select name from sqlite_master where type = 'index' and tbl_name = ?`)
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

describe("language + audit schema", () => {
  // Fresh databases get everything from SCHEMA_SQL, which runs on every boot.
  it("creates language columns on fresh databases", () => {
    db.exec(SCHEMA_SQL);

    expect(columns("projects")).toContain("language");
    expect(columns("projects")).toContain("env_ciphertext");
    expect(columns("builds")).toContain("language");
  });

  it("creates the admin audit table on fresh databases", () => {
    db.exec(SCHEMA_SQL);

    expect(columns("admin_audit")).toEqual(
      expect.arrayContaining(["id", "admin_id", "action", "created_at"])
    );
    expect(indexes("admin_audit")).toContain("idx_admin_audit_created");
  });

  it("creates the 0014 lookup indexes on fresh databases", () => {
    db.exec(SCHEMA_SQL);

    expect(indexes("webhook_events")).toContain("idx_webhook_events_processed");
    expect(indexes("user_sessions")).toContain("idx_user_sessions_token");
  });

  // Databases created before 0015 have projects/builds tables without the new
  // columns; applyMigrations must add them without touching existing data.
  it("backfills language columns onto legacy tables", () => {    db.exec(`
      create table users (id text primary key, email text not null unique);
      create table projects (id text primary key, user_id text not null, name text not null);
      create table builds (id text primary key, user_id text not null, project_id text not null);
    `);
    db.prepare("insert into projects (id, user_id, name) values (?, ?, ?)").run(
      "p1",
      "u1",
      "demo"
    );

    applyMigrations(db);

    expect(columns("projects")).toContain("language");
    expect(columns("projects")).toContain("env_ciphertext");
    expect(columns("builds")).toContain("language");
    const names = (
      db.prepare("select name from projects").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(["demo"]);
  });
});

describe("feedback schema", () => {
  // Fresh databases get the inbox from SCHEMA_SQL, which runs on every boot.
  it("creates the feedback table on fresh databases", () => {
    db.exec(SCHEMA_SQL);

    expect(columns("feedback")).toEqual(
      expect.arrayContaining(["id", "user_id", "message", "is_read", "created_at"])
    );
    expect(indexes("feedback")).toContain("idx_feedback_unread");
  });

  it("stores and reads feedback rows", () => {
    db.exec(SCHEMA_SQL);
    db.prepare("insert into users (id, email) values (?, ?)").run("u9", "fan@example.test");
    db.prepare("insert into feedback (id, user_id, message) values (?, ?, ?)").run(
      "f1",
      "u9",
      "Ship it!"
    );

    const rows = db
      .prepare("select message, is_read from feedback where user_id = ?")
      .all("u9") as { message: string; is_read: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("Ship it!");
    expect(rows[0].is_read).toBe(0);

    db.prepare("update feedback set is_read = ? where id = ?").run(1, "f1");
    const unread = (
      db.prepare("select id from feedback where is_read = ?").all(0) as unknown[]
    ).length;
    expect(unread).toBe(0);
  });
});
