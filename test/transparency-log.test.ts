import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/db";
import { appendTransparencyLogRow } from "../src/transparency-log";

function insertDelegation(delegationId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  db.prepare(
    `INSERT INTO delegations (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    delegationId,
    "delegator-pub-key",
    "delegate-pub-key",
    '{"allowed_actions":["email-rewrite"]}',
    "bond-123",
    "pending",
    now,
    expiresAt
  );
}

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
});

describe("transparency log", () => {
  it("appends one valid row", () => {
    insertDelegation("delegation-1");

    const row = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const db = getDb();
    const stored = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(row.id) as Record<string, unknown>;

    expect(stored).toMatchObject({
      id: row.id,
      delegation_id: "delegation-1",
      reservation_id: null,
      event_type: "delegation_created",
      actor_kind: "delegator",
      agentgate_action_id: null,
      outcome: null,
      reason_code: null,
      created_at: row.created_at,
    });
  });

  it("rejects unsupported event_type", () => {
    insertDelegation("delegation-1");

    expect(() =>
      appendTransparencyLogRow({
        delegationId: "delegation-1",
        eventType: "not_allowed" as never,
        actorKind: "checkpoint",
      })
    ).toThrow("Unsupported transparency log event_type: not_allowed");
  });

  it("rejects unsupported actor_kind", () => {
    insertDelegation("delegation-1");

    expect(() =>
      appendTransparencyLogRow({
        delegationId: "delegation-1",
        eventType: "checkpoint_action_reserved",
        actorKind: "operator" as never,
      })
    ).toThrow("Unsupported transparency log actor_kind: operator");
  });

  it("appending a second row leaves the first row untouched", () => {
    insertDelegation("delegation-1");

    const firstRow = appendTransparencyLogRow({
      delegationId: "delegation-1",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const db = getDb();
    const firstStoredBefore = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(firstRow.id) as Record<string, unknown>;

    appendTransparencyLogRow({
      delegationId: "delegation-1",
      reservationId: "reservation-1",
      eventType: "checkpoint_action_reserved",
      actorKind: "checkpoint",
      reasonCode: "policy_checked",
    });

    const firstStoredAfter = db
      .prepare("SELECT * FROM delegation_transparency_log WHERE id = ?")
      .get(firstRow.id) as Record<string, unknown>;
    const rowCount = db
      .prepare("SELECT COUNT(*) as count FROM delegation_transparency_log")
      .get() as { count: number };

    expect(firstStoredAfter).toEqual(firstStoredBefore);
    expect(rowCount.count).toBe(2);
  });
});
