import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb } from "../src/db";
import {
  CHECKPOINT_FORWARD_STATE_IN_FORWARD,
  CHECKPOINT_FORWARD_STATE_PENDING,
  CheckpointForwardTransitionError,
  createDelegation,
  getDelegation,
  claimForAccept,
  finalizeAccept,
  revertAccept,
  reserveCheckpointAction,
  reserveAction,
  finalizeAction,
  revertAction,
  resolveAction,
  revokeDelegation,
  closeDelegation,
  checkExpiry,
  computeOutcome,
  getCheckpointReservationForwardStatus,
  recoverTransientStates,
  getActions,
  getEvents,
  startCheckpointForwardAttempt,
  type DelegationRow,
} from "../src/delegation";
import type { DelegationScope } from "../src/scope";

const TEST_SCOPE: DelegationScope = {
  allowed_actions: ["email-rewrite", "file-transform"],
  max_actions: 3,
  max_exposure_cents: 83,
  max_total_exposure_cents: 300,
  description: "Test delegation scope",
};

function makeTestDelegation(overrides?: Partial<{
  ttlSeconds: number;
  scope: DelegationScope;
}>): DelegationRow {
  return createDelegation({
    delegatorId: "human-pub-key",
    delegateId: "agent-pub-key",
    scope: overrides?.scope ?? TEST_SCOPE,
    delegatorBondId: "human-bond-123",
    ttlSeconds: overrides?.ttlSeconds ?? 3600,
  });
}

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
});

describe("createDelegation", () => {
  it("creates a delegation in pending status", () => {
    const d = makeTestDelegation();
    expect(d.status).toBe("pending");
    expect(d.delegator_id).toBe("human-pub-key");
    expect(d.delegate_id).toBe("agent-pub-key");
    expect(d.delegator_bond_id).toBe("human-bond-123");
    expect(d.delegate_bond_id).toBeNull();
    expect(d.terminal_reason).toBeNull();
    expect(d.delegation_outcome).toBeNull();
  });

  it("logs delegation_created event", () => {
    const d = makeTestDelegation();
    const events = getEvents(d.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("delegation_created");
  });

  it("sets expires_at based on ttlSeconds", () => {
    const d = makeTestDelegation({ ttlSeconds: 7200 });
    const created = new Date(d.created_at).getTime();
    const expires = new Date(d.expires_at).getTime();
    // Should be ~7200 seconds apart (allow 2 second tolerance)
    expect(Math.abs(expires - created - 7200_000)).toBeLessThan(2000);
  });
});

describe("accept — two-phase", () => {
  it("claim moves status to accepting", () => {
    const d = makeTestDelegation();
    const claimed = claimForAccept(d.id, "agent-pub-key");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("accepting");
  });

  it("finalize moves to accepted with bond ID", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    const accepted = finalizeAccept(d.id, "agent-bond-456");
    expect(accepted).not.toBeNull();
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.delegate_bond_id).toBe("agent-bond-456");
    expect(accepted!.accepted_at).not.toBeNull();
  });

  it("revert moves back to pending", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    revertAccept(d.id);
    const reverted = getDelegation(d.id)!;
    expect(reverted.status).toBe("pending");
  });

  it("double-claim fails", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    const second = claimForAccept(d.id, "agent-pub-key");
    expect(second).toBeNull();
  });

  it("cannot accept expired delegation", () => {
    const d = makeTestDelegation({ ttlSeconds: -1 }); // already expired
    const claimed = claimForAccept(d.id, "agent-pub-key");
    expect(claimed).toBeNull();
  });

  it("rejects accept from the wrong agent key", () => {
    const d = makeTestDelegation();
    const claimed = claimForAccept(d.id, "wrong-agent-pub-key");
    expect(claimed).toBeNull();
  });

  it("logs delegation_accepted event on finalize", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");
    const events = getEvents(d.id);
    const acceptEvent = events.find(
      (e) => e.event_type === "delegation_accepted"
    );
    expect(acceptEvent).toBeDefined();
  });
});

describe("act — two-phase with scope validation", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  it("reserves a valid action", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 83,
    });

    expect("actionId" in result).toBe(true);
  });

  it("rejects action type not in allowlist", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "delete-all",
      declaredExposureCents: 50,
    });

    expect("valid" in result && !result.valid).toBe(true);
  });

  it("rejects action on pending delegation", () => {
    const d = makeTestDelegation();

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    expect("valid" in result && !result.valid).toBe(true);
  });

  it("finalizeAction moves delegation to active", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 83,
    });

    if (!("actionId" in result)) throw new Error("Expected reservation");

    finalizeAction(result.actionId, d.id, "ag-action-001");
    const updated = getDelegation(d.id)!;
    expect(updated.status).toBe("active");
  });

  it("revertAction removes the reserved action", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 83,
    });

    if (!("actionId" in result)) throw new Error("Expected reservation");

    revertAction(result.actionId);
    const actions = getActions(d.id);
    expect(actions).toHaveLength(0);
  });

  it("logs action_rejected_scope event on scope violation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "delete-all",
      declaredExposureCents: 50,
    });

    const events = getEvents(d.id);
    const rejected = events.find(
      (e) => e.event_type === "action_rejected_scope"
    );
    expect(rejected).toBeDefined();
  });

  it("logs action_executed event on finalize", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    const events = getEvents(d.id);
    const executed = events.find((e) => e.event_type === "action_executed");
    expect(executed).toBeDefined();
  });

  it("rejects actions from a non-delegated agent key", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "wrong-agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    expect("valid" in result && !result.valid).toBe(true);
    if ("valid" in result) {
      expect(result.reason).toContain("delegated agent");
    }
  });

  it("counts in-flight reservations against max_actions immediately", () => {
    const d = makeTestDelegation({
      scope: {
        ...TEST_SCOPE,
        max_actions: 1,
      },
    });
    acceptDelegation(d.id);

    const first = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in first)) throw new Error("Expected reservation");

    const second = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    expect("valid" in second && !second.valid).toBe(true);
  });

  it("counts in-flight reservations against total exposure immediately", () => {
    const d = makeTestDelegation({
      scope: {
        ...TEST_SCOPE,
        max_actions: 3,
        max_total_exposure_cents: 100,
      },
    });
    acceptDelegation(d.id);

    const first = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 83,
    });
    if (!("actionId" in first)) throw new Error("Expected reservation");

    const second = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 1,
    });

    expect("valid" in second && !second.valid).toBe(true);
  });
});

describe("resolveAction", () => {
  function setupWithAction(): { delegationId: string; actionId: string } {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    return { delegationId: d.id, actionId: result.actionId };
  }

  it("resolves an action with success", () => {
    const { actionId } = setupWithAction();
    const resolved = resolveAction(actionId, "success");
    expect(resolved).not.toBeNull();
    expect(resolved!.outcome).toBe("success");
    expect(resolved!.resolved_at).not.toBeNull();
  });

  it("cannot double-resolve", () => {
    const { actionId } = setupWithAction();
    resolveAction(actionId, "success");
    const second = resolveAction(actionId, "failed");
    expect(second).toBeNull();
  });

  it("logs action_resolved event", () => {
    const { delegationId, actionId } = setupWithAction();
    resolveAction(actionId, "success");
    const events = getEvents(delegationId);
    const resolved = events.find((e) => e.event_type === "action_resolved");
    expect(resolved).toBeDefined();
  });
});

describe("checkpoint forward transition", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  it("transitions an eligible checkpoint reservation from pending_forward to in_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    expect(getCheckpointReservationForwardStatus(reservation.reservationId)).toEqual({
      action: expect.objectContaining({
        id: reservation.reservationId,
        forward_state: CHECKPOINT_FORWARD_STATE_PENDING,
      }),
      eligible: true,
    });

    const updated = startCheckpointForwardAttempt(reservation.reservationId);

    expect(updated.forward_state).toBe(CHECKPOINT_FORWARD_STATE_IN_FORWARD);
    expect(getCheckpointReservationForwardStatus(reservation.reservationId)).toEqual({
      action: expect.objectContaining({
        id: reservation.reservationId,
        forward_state: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      }),
      eligible: false,
    });
  });

  it("rejects a second forward transition attempt on the same reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);

    expect(() => startCheckpointForwardAttempt(reservation.reservationId)).toThrowError(
      expect.objectContaining({
        name: "CheckpointForwardTransitionError",
        code: "RESERVATION_NOT_FORWARDABLE",
      })
    );
  });

  it("rejects a reservation that is not eligible for checkpoint forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");

    try {
      startCheckpointForwardAttempt(result.actionId);
      throw new Error("Expected forward transition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointForwardTransitionError);
      expect((error as CheckpointForwardTransitionError).code).toBe(
        "RESERVATION_NOT_FORWARDABLE"
      );
    }
  });

  it("logs checkpoint_forward_started once on a successful transition", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);

    const forwardStartedEvents = getEvents(d.id).filter(
      (event) => event.event_type === "checkpoint_forward_started"
    );

    expect(forwardStartedEvents).toHaveLength(1);
    expect(JSON.parse(forwardStartedEvents[0].detail_json ?? "{}")).toEqual({
      reservation_id: reservation.reservationId,
      from_forward_state: CHECKPOINT_FORWARD_STATE_PENDING,
      forward_state: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
    });
  });
});

describe("auto-complete — exhaustion", () => {
  it("auto-completes when all max_actions resolved", () => {
    const scope: DelegationScope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 1,
      max_exposure_cents: 83,
      max_total_exposure_cents: 300,
      description: "Single action",
    };
    const d = makeTestDelegation({ scope });
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    // Resolve the action — should auto-complete
    resolveAction(result.actionId, "success");

    const final = getDelegation(d.id)!;
    expect(final.status).toBe("completed");
    expect(final.terminal_reason).toBe("exhausted");
    expect(final.delegation_outcome).toBe("success");
  });
});

describe("revokeDelegation", () => {
  it("revokes pending delegation straight to completed", () => {
    const d = makeTestDelegation();
    const revoked = revokeDelegation(d.id);
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe("completed");
    expect(revoked!.terminal_reason).toBe("revoked");
    expect(revoked!.delegation_outcome).toBe("none");
  });

  it("revokes active delegation with no open actions to completed", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");
    resolveAction(result.actionId, "success");

    const revoked = revokeDelegation(d.id);
    expect(revoked!.status).toBe("completed");
    expect(revoked!.terminal_reason).toBe("revoked");
    expect(revoked!.delegation_outcome).toBe("success");
  });

  it("revokes active delegation with open actions to settling", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    const revoked = revokeDelegation(d.id);
    expect(revoked!.status).toBe("settling");
    expect(revoked!.terminal_reason).toBe("revoked");
  });

  it("treats an in-flight reservation as open when revoking", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");

    const revoked = revokeDelegation(d.id);
    expect(revoked!.status).toBe("settling");
    expect(revoked!.terminal_reason).toBe("revoked");
  });

  it("settling completes when last action resolved", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    revokeDelegation(d.id);
    resolveAction(result.actionId, "success");

    const final = getDelegation(d.id)!;
    expect(final.status).toBe("completed");
    expect(final.terminal_reason).toBe("revoked");
    expect(final.delegation_outcome).toBe("success");
  });

  it("cannot revoke completed delegation", () => {
    const d = makeTestDelegation();
    revokeDelegation(d.id); // completes it
    const second = revokeDelegation(d.id);
    expect(second).toBeNull();
  });

  it("cannot revoke a delegation already in settling", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    expect(revokeDelegation(d.id)?.status).toBe("settling");
    expect(revokeDelegation(d.id)).toBeNull();
    expect(getDelegation(d.id)!.terminal_reason).toBe("revoked");
  });
});

describe("closeDelegation", () => {
  it("closes active delegation with all actions resolved", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");
    resolveAction(result.actionId, "success");

    const closed = closeDelegation(d.id);
    expect(closed!.status).toBe("completed");
    expect(closed!.terminal_reason).toBe("closed");
  });

  it("cannot close pending delegation", () => {
    const d = makeTestDelegation();
    const closed = closeDelegation(d.id);
    expect(closed).toBeNull();
  });

  it("cannot close with open actions", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    const closed = closeDelegation(d.id);
    expect(closed).toBeNull();
  });
});

describe("checkExpiry", () => {
  it("expires pending delegation to completed", () => {
    const d = makeTestDelegation({ ttlSeconds: -1 });
    const expired = checkExpiry(d.id);
    expect(expired).not.toBeNull();
    expect(expired!.status).toBe("completed");
    expect(expired!.terminal_reason).toBe("expired");
  });

  it("does not expire non-expired delegation", () => {
    const d = makeTestDelegation({ ttlSeconds: 3600 });
    const result = checkExpiry(d.id);
    expect(result).toBeNull();
  });

  it("does not overwrite terminal reason for settling delegations", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const result = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in result)) throw new Error("Expected reservation");
    finalizeAction(result.actionId, d.id, "ag-action-001");

    revokeDelegation(d.id);
    const db = getDb();
    db.prepare("UPDATE delegations SET expires_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      d.id
    );

    expect(checkExpiry(d.id)).toBeNull();
    expect(getDelegation(d.id)!.status).toBe("settling");
    expect(getDelegation(d.id)!.terminal_reason).toBe("revoked");
  });
});

describe("computeOutcome", () => {
  it("returns 'none' with no actions", () => {
    const d = makeTestDelegation();
    expect(computeOutcome(d.id)).toBe("none");
  });

  it("returns 'success' when all succeed", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const r1 = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in r1)) throw new Error("Expected reservation");
    finalizeAction(r1.actionId, d.id, "ag-1");
    resolveAction(r1.actionId, "success");

    expect(computeOutcome(d.id)).toBe("success");
  });

  it("returns 'agent-malicious' if any malicious", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const r1 = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in r1)) throw new Error("Expected reservation");
    finalizeAction(r1.actionId, d.id, "ag-1");
    resolveAction(r1.actionId, "malicious");

    expect(computeOutcome(d.id)).toBe("agent-malicious");
  });

  it("returns 'failed' if any failed and none malicious", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const r1 = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in r1)) throw new Error("Expected reservation");
    finalizeAction(r1.actionId, d.id, "ag-1");
    resolveAction(r1.actionId, "failed");

    expect(computeOutcome(d.id)).toBe("failed");
  });
});

describe("recoverTransientStates", () => {
  it("reverts accepting back to pending", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key"); // now in 'accepting'

    const recovered = recoverTransientStates();
    expect(recovered).toBe(1);

    const reverted = getDelegation(d.id)!;
    expect(reverted.status).toBe("pending");
  });

  it("marks delegations with orphaned local action reservations as failed", () => {
    const d = makeTestDelegation();
    claimForAccept(d.id, "agent-pub-key");
    finalizeAccept(d.id, "agent-bond-456");

    const reservation = reserveAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      declaredExposureCents: 50,
    });
    if (!("actionId" in reservation)) throw new Error("Expected reservation");

    const recovered = recoverTransientStates();
    expect(recovered).toBe(1);

    const failed = getDelegation(d.id)!;
    expect(failed.status).toBe("failed");

    const events = getEvents(d.id);
    expect(
      events.some((event) => event.event_type === "delegation_recovery_failed")
    ).toBe(true);
  });
});
