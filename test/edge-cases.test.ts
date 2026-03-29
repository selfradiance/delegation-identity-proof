import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb } from "../src/db";
import {
  createDelegation,
  getDelegation,
  claimForAccept,
  finalizeAccept,
  reserveAction,
  finalizeAction,
  resolveAction,
  revokeDelegation,
  closeDelegation,
  checkExpiry,
  computeOutcome,
  getActions,
  getEvents,
} from "../src/delegation";
import { effectiveExposure } from "../src/scope";
import type { DelegationScope } from "../src/scope";

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
});

function quickDelegation(overrides?: Partial<{
  ttlSeconds: number;
  scope: DelegationScope;
}>) {
  return createDelegation({
    delegatorId: "human-key",
    delegateId: "agent-key",
    scope: overrides?.scope ?? {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 300,
      description: "Test",
    },
    delegatorBondId: "bond-h",
    ttlSeconds: overrides?.ttlSeconds ?? 3600,
  });
}

function acceptIt(id: string) {
  claimForAccept(id, "agent-key");
  finalizeAccept(id, "bond-a");
}

function actAndFinalize(delegationId: string, exposure = 50) {
  const r = reserveAction({
    delegationId,
    actorPublicKey: "agent-key",
    actionType: "email-rewrite",
    declaredExposureCents: exposure,
  });
  if (!("actionId" in r)) throw new Error(`Reservation failed: ${r.reason}`);
  finalizeAction(r.actionId, delegationId, `ag-${r.actionId.slice(0, 8)}`);
  return r.actionId;
}

describe("capacity math edge cases", () => {
  it("effectiveExposure rounds up correctly for all boundary values", () => {
    // 0 → 0 (degenerate)
    expect(effectiveExposure(0)).toBe(0);
    // 1 → ceil(1.2) = 2
    expect(effectiveExposure(1)).toBe(2);
    // 5 → ceil(6) = 6
    expect(effectiveExposure(5)).toBe(6);
    // 83 → ceil(99.6) = 100 (the key Tier 1 demo value)
    expect(effectiveExposure(83)).toBe(100);
    // 84 → ceil(100.8) = 101
    expect(effectiveExposure(84)).toBe(101);
    // 100 → ceil(120) = 120 (exact multiple)
    expect(effectiveExposure(100)).toBe(120);
  });

  it("total exposure tracking uses effective (1.2×), not declared", () => {
    const scope: DelegationScope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 5,
      max_exposure_cents: 83,
      max_total_exposure_cents: 200, // tight limit
      description: "Test",
    };
    const d = quickDelegation({ scope });
    acceptIt(d.id);

    // First action: 83¢ declared → 100¢ effective
    const a1 = actAndFinalize(d.id, 83);
    resolveAction(a1, "success");

    // Second action: 83¢ declared → 100¢ effective → total = 200¢ (exactly at limit)
    const a2 = actAndFinalize(d.id, 83);
    resolveAction(a2, "success");

    // Third action: would push to 300¢ → should be rejected
    const r3 = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-key",
      actionType: "email-rewrite",
      declaredExposureCents: 83,
    });
    expect("valid" in r3 && !r3.valid).toBe(true);
  });
});

describe("expiry edge cases", () => {
  it("expired delegation rejects accept", () => {
    const d = quickDelegation({ ttlSeconds: -1 });
    const claimed = claimForAccept(d.id, "agent-key");
    expect(claimed).toBeNull();
  });

  it("expired delegation rejects action", () => {
    // Create with very short TTL, accept immediately
    const d = quickDelegation({ ttlSeconds: -1 });
    // Force status to accepted for testing
    const db = getDb();
    db.prepare("UPDATE delegations SET status = 'accepted' WHERE id = ?").run(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    expect("valid" in result && !result.valid).toBe(true);
    expect((result as { reason: string }).reason).toContain("expired");
  });

  it("checkExpiry on active delegation with open actions goes to settling", () => {
    const d = quickDelegation({ ttlSeconds: -1 });
    // Force through lifecycle
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE delegations SET status = 'active', accepted_at = ?, delegate_bond_id = 'bond-a' WHERE id = ?"
    ).run(now, d.id);
    // Insert an open action
    db.prepare(
      `INSERT INTO delegation_actions (id, delegation_id, agentgate_action_id, action_type, declared_exposure_cents, effective_exposure_cents, created_at)
       VALUES ('act-1', ?, 'ag-1', 'email-rewrite', 50, 60, ?)`
    ).run(d.id, now);

    const expired = checkExpiry(d.id);
    expect(expired!.status).toBe("settling");
    expect(expired!.terminal_reason).toBe("expired");
  });
});

describe("settling state", () => {
  it("cannot act on settling delegation", () => {
    const d = quickDelegation();
    acceptIt(d.id);
    const actionId = actAndFinalize(d.id);

    // Revoke while action is open → settling
    revokeDelegation(d.id);
    const settling = getDelegation(d.id)!;
    expect(settling.status).toBe("settling");

    // Try to act — should fail
    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    expect("valid" in result && !result.valid).toBe(true);
  });

  it("settling delegation completes when last action resolves", () => {
    const d = quickDelegation();
    acceptIt(d.id);
    const a1 = actAndFinalize(d.id);
    const a2 = actAndFinalize(d.id);

    revokeDelegation(d.id);
    expect(getDelegation(d.id)!.status).toBe("settling");

    resolveAction(a1, "success");
    expect(getDelegation(d.id)!.status).toBe("settling"); // still settling

    resolveAction(a2, "success");
    expect(getDelegation(d.id)!.status).toBe("completed"); // now done
    expect(getDelegation(d.id)!.delegation_outcome).toBe("success");
  });
});

describe("outcome computation edge cases", () => {
  it("malicious trumps failed", () => {
    const scope: DelegationScope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 2,
      max_exposure_cents: 83,
      max_total_exposure_cents: 300,
      description: "Test",
    };
    const d = quickDelegation({ scope });
    acceptIt(d.id);

    const a1 = actAndFinalize(d.id);
    const a2 = actAndFinalize(d.id);

    resolveAction(a1, "failed");
    resolveAction(a2, "malicious");

    expect(getDelegation(d.id)!.delegation_outcome).toBe("agent-malicious");
  });

  it("single failed action yields failed outcome", () => {
    const scope: DelegationScope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 1,
      max_exposure_cents: 83,
      max_total_exposure_cents: 300,
      description: "Test",
    };
    const d = quickDelegation({ scope });
    acceptIt(d.id);

    const a1 = actAndFinalize(d.id);
    resolveAction(a1, "failed");

    expect(getDelegation(d.id)!.delegation_outcome).toBe("failed");
  });

  it("revoke with no actions yields none outcome", () => {
    const d = quickDelegation();
    revokeDelegation(d.id);
    expect(getDelegation(d.id)!.delegation_outcome).toBe("none");
  });

  it("revoke after accept with no actions yields none outcome", () => {
    const d = quickDelegation();
    acceptIt(d.id);
    revokeDelegation(d.id);
    expect(getDelegation(d.id)!.delegation_outcome).toBe("none");
  });
});

describe("guard clauses", () => {
  it("cannot accept non-existent delegation", () => {
    const result = claimForAccept("nonexistent-id", "agent-key");
    expect(result).toBeNull();
  });

  it("cannot close pending delegation", () => {
    const d = quickDelegation();
    expect(closeDelegation(d.id)).toBeNull();
  });

  it("cannot close accepted delegation (needs to be active)", () => {
    const d = quickDelegation();
    acceptIt(d.id);
    expect(closeDelegation(d.id)).toBeNull();
  });

  it("cannot resolve same action twice", () => {
    const d = quickDelegation();
    acceptIt(d.id);
    const a = actAndFinalize(d.id);
    resolveAction(a, "success");
    expect(resolveAction(a, "failed")).toBeNull();
  });

  it("cannot act on completed delegation", () => {
    const d = quickDelegation();
    revokeDelegation(d.id);
    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    expect("valid" in result && !result.valid).toBe(true);
  });
});

describe("event trail completeness", () => {
  it("full lifecycle produces complete event trail", () => {
    const scope: DelegationScope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 1,
      max_exposure_cents: 83,
      max_total_exposure_cents: 300,
      description: "Test",
    };
    const d = quickDelegation({ scope });
    acceptIt(d.id);
    const a = actAndFinalize(d.id);
    resolveAction(a, "success");

    const events = getEvents(d.id);
    const types = events.map((e) => e.event_type);

    expect(types).toContain("delegation_created");
    expect(types).toContain("delegation_accepted");
    expect(types).toContain("action_executed");
    expect(types).toContain("action_resolved");
    expect(types).toContain("delegation_completed");
  });

  it("scope rejection is logged in events", () => {
    const d = quickDelegation();
    acceptIt(d.id);

    reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-key",
      actionType: "not-allowed",
      declaredExposureCents: 50,
    });

    const events = getEvents(d.id);
    const rejected = events.find((e) => e.event_type === "action_rejected_scope");
    expect(rejected).toBeDefined();
    expect(rejected!.detail_json).toContain("not-allowed");
  });
});
