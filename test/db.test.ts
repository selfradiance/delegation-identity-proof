import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb } from "../src/db";

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
});

describe("db — schema", () => {
  it("creates all four tables", () => {
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("delegations");
    expect(tableNames).toContain("delegation_actions");
    expect(tableNames).toContain("delegation_events");
    expect(tableNames).toContain("delegation_transparency_log");
  });

  it("delegations table has expected columns", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(delegations)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual([
      "id",
      "delegator_id",
      "delegate_id",
      "scope_json",
      "delegator_bond_id",
      "delegate_bond_id",
      "delegator_bond_outcome",
      "delegator_bond_resolved_at",
      "delegation_outcome",
      "status",
      "terminal_reason",
      "created_at",
      "accepted_at",
      "expires_at",
      "completed_at",
    ]);
  });

  it("delegation_actions table has expected columns", () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(delegation_actions)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual([
      "id",
      "delegation_id",
      "agentgate_action_id",
      "forward_state",
      "action_type",
      "payload_json",
      "declared_exposure_cents",
      "effective_exposure_cents",
      "outcome",
      "created_at",
      "resolved_at",
    ]);
  });

  it("delegation_events table has expected columns", () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(delegation_events)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual([
      "id",
      "delegation_id",
      "event_type",
      "detail_json",
      "created_at",
    ]);
  });

  it("delegation_transparency_log table has expected columns", () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(delegation_transparency_log)")
      .all() as { name: string }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual([
      "id",
      "delegation_id",
      "reservation_id",
      "event_type",
      "actor_kind",
      "agentgate_action_id",
      "outcome",
      "reason_code",
      "created_at",
    ]);
  });

  it("foreign keys are enforced", () => {
    const db = getDb();
    const fkResult = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(fkResult.foreign_keys).toBe(1);
  });

  it("can insert and retrieve a delegation record", () => {
    const db = getDb();
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 3600_000).toISOString();

    db.prepare(
      `INSERT INTO delegations (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "test-id",
      "delegator-pub-key",
      "delegate-pub-key",
      '{"allowed_actions":["email-rewrite"]}',
      "bond-123",
      "pending",
      now,
      expires
    );

    const row = db
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get("test-id") as Record<string, unknown>;

    expect(row.id).toBe("test-id");
    expect(row.status).toBe("pending");
    expect(row.delegate_bond_id).toBeNull();
  });
});
