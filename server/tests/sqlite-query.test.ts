import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "../src/db/sqlite/binding.js";
import { TableQuery } from "../src/db/sqlite/query.js";
import { SCHEMA_SQL, SEED_PLANS_SQL } from "../src/db/sqlite/schema.js";

let db: DatabaseSync;

/**
 * The seeded plans are the fixture these builder tests share, so their count and
 * order are derived from the seed rather than hardcoded. Adding a tier then
 * leaves these tests testing the query builder, which is the point.
 */
function seededPlanIds(): string[] {
  const rows = db.prepare("select id from plans order by price_cents desc").all() as { id: string }[];
  return rows.map((r) => r.id);
}

function planCount(): number {
  return seededPlanIds().length;
}

function priciestPlanIds(): string[] {
  return seededPlanIds().slice(0, 2);
}

function table(name: string) {
  return new TableQuery(db, name);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(SCHEMA_SQL);
  db.exec(SEED_PLANS_SQL);

  // Most tables reference users(id), so the fixture needs a parent row or the
  // foreign keys correctly reject every insert.
  db.prepare("insert into users (id, email, plan_id) values (?, ?, ?)").run(
    "u1",
    "dev@example.test",
    "free"
  );
  db.prepare("insert into projects (id, user_id, name) values (?, ?, ?)").run(
    "p1",
    "u1",
    "demo"
  );
});

afterEach(() => {
  db.close();
});

describe("sqlite query builder", () => {
  it("selects all rows", async () => {
    const { data, error } = await table("plans").select("*");
    expect(error).toBeNull();
    expect(data).toHaveLength(planCount());
  });

  it("filters with eq and returns a single row", async () => {
    const { data, error } = await table("plans")
      .select("id,name")
      .eq("id", "pro")
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({ id: "pro", name: "Pro" });
  });

  it("reports an error for a missing single row", async () => {
    const { data, error } = await table("plans").select("*").eq("id", "nope").single();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("orders and limits", async () => {
    const { data } = await table("plans")
      .select("id,price_cents")
      .order("price_cents", { ascending: false })
      .limit(2);

    // The two most expensive seeded plans, named from the seed so adding or
    // repricing a tier does not silently break this.
    expect(data?.map((r) => r.id)).toEqual(priciestPlanIds());
  });

  it("inserts a row", async () => {
    const { error } = await table("api_keys").insert({
      id: "k1",
      user_id: "u1",
      key_hash: "hash1",
      key_prefix: "ox_live_ab",
      name: "test",
      is_active: true,
    });
    expect(error).toBeNull();

    const { data } = await table("api_keys").select("*").eq("key_hash", "hash1").single();
    expect(data?.user_id).toBe("u1");
  });

  it("stores booleans in a way that reads back as booleans", async () => {
    await table("api_keys").insert({
      id: "k2",
      user_id: "u1",
      key_hash: "hash2",
      key_prefix: "ox_live_cd",
      name: "test",
      is_active: false,
    });

    const { data } = await table("api_keys").select("is_active").eq("id", "k2").single();
    expect(data?.is_active).toBe(false);
  });

  it("inserts without overwriting an existing row", async () => {
    const row = {
      id: "k3",
      user_id: "u1",
      key_hash: "hash3",
      key_prefix: "ox_live_ef",
      name: "first",
      is_active: true,
    };
    await table("api_keys").insert(row);
    await table("api_keys").insert({ ...row, name: "second" });

    const { data } = await table("api_keys").select("name").eq("id", "k3").single();
    expect(data?.name).toBe("first");
  });

  it("upserts by the conflict target, updating existing rows", async () => {
    await table("plans").upsert(
      { id: "free", name: "Free", price_cents: 0, runtime_hours_per_month: 24 },
      { onConflict: "id" }
    );

    const { data } = await table("plans").select("name,price_cents").eq("id", "free").single();
    expect(data?.name).toBe("Free");
  });

  it("updates rows matching a condition", async () => {
    await table("api_keys").insert({
      id: "k4",
      user_id: "u1",
      key_hash: "hash4",
      key_prefix: "ox_live_gh",
      name: "test",
      is_active: true,
    });

    const { error } = await table("api_keys").update({ is_active: false }).eq("id", "k4");
    expect(error).toBeNull();

    const { data } = await table("api_keys").select("is_active").eq("id", "k4").single();
    expect(data?.is_active).toBe(false);
  });

  it("compares timestamps with lt", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    await table("runtimes").insert({
      id: "r1",
      user_id: "u1",
      project_id: "p1",
      status: "running",
      lease_expires_at: past,
    });
    await table("runtimes").insert({
      id: "r2",
      user_id: "u1",
      project_id: "p1",
      status: "running",
      lease_expires_at: future,
    });

    const { data } = await table("runtimes")
      .select("id")
      .eq("status", "running")
      .lt("lease_expires_at", new Date().toISOString());

    expect(data?.map((r) => r.id)).toEqual(["r1"]);
  });

  it("returns the inserted row for insert().select().single()", async () => {
    const { data, error } = await table("builds")
      .insert({
        id: "b2",
        user_id: "u1",
        project_id: "p1",
        status: "pending",
        install_commands: [],
        build_commands: [],
        test_commands: ["node --check server.js"],
      })
      .select()
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe("b2");
    expect(data?.status).toBe("pending");
  });

  it("stores json columns as text without breaking the insert", async () => {
    const { error } = await table("builds").insert({
      id: "b1",
      user_id: "u1",
      project_id: "p1",
      status: "pending",
      install_commands: ["npm ci"],
      build_commands: ["npm run build"],
      test_commands: [],
    });
    expect(error).toBeNull();

    const { data } = await table("builds").select("build_commands").eq("id", "b1").single();
    expect(typeof data?.build_commands).toBe("string");
  });

  it("rejects unsafe identifiers instead of building the statement", async () => {
    const { error } = await table("plans").select("id").eq("id; drop table plans", "x");
    expect(error).not.toBeNull();

    const { data } = await table("plans").select("id");
    expect(data).toHaveLength(planCount());
  });

  it("enforces the foreign key to users", async () => {
    const { error } = await table("api_keys").insert({
      id: "k5",
      user_id: "ghost",
      key_hash: "hash5",
      key_prefix: "ox_live_ij",
      name: "test",
      is_active: true,
    });
    expect(error).not.toBeNull();
  });

  it("rejects a status outside the check constraint", async () => {
    const { error } = await table("runtimes").insert({
      id: "r3",
      user_id: "u1",
      project_id: "p1",
      status: "not-a-status",
      lease_expires_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });
});
