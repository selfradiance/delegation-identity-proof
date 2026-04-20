import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import * as agentGateClient from "../src/agentgate-client";
import { closeDb, getDb } from "../src/db";
import {
  attachCheckpointForwardedAction,
  CHECKPOINT_FORWARD_FAILURE_REASON_PRE_ATTACHMENT,
  CheckpointForwardFinalizationError,
  CheckpointForwardFailureError,
  CHECKPOINT_FORWARD_STATE_FORWARDED,
  CHECKPOINT_FORWARD_STATE_IN_FORWARD,
  CHECKPOINT_FORWARD_STATE_PENDING,
  CheckpointExecutePreparationError,
  CheckpointExecuteRequestBuildError,
  CheckpointForwardAttachmentError,
  CheckpointForwardTransitionError,
  buildCheckpointAgentGateExecuteRequest,
  createDelegation,
  getDelegation,
  claimForAccept,
  finalizeAccept,
  revertAccept,
  reserveCheckpointAction,
  reserveAction,
  finalizeAction,
  revertAction,
  failCheckpointForwardAttempt,
  finalizeCheckpointAgentGateExecuteRequest,
  finalizeCheckpointForwardedAction,
  executeCheckpointForwardHandoff,
  getCheckpointExecuteReadiness,
  getCheckpointReservationExecutionStatus,
  isCheckpointReservationExecuteEligible,
  prepareCheckpointExecuteInput,
  prepareFinalCheckpointAgentGateExecuteBody,
  resolveCheckpointForwardedReservation,
  resolveAction,
  revokeDelegation,
  closeDelegation,
  checkExpiry,
  computeOutcome,
  getCheckpointReservationForwardStatus,
  recoverTransientStates,
  resolveCheckpointAgentGateIdentityId,
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
const TEST_CHECKPOINT_IDENTITY_FILE = "test-checkpoint-execute-identity.json";
const TEST_RESOLVER_IDENTITY_FILE = "test-checkpoint-resolver-identity.json";

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
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_CHECKPOINT_IDENTITY_FILE)) {
    fs.unlinkSync(TEST_CHECKPOINT_IDENTITY_FILE);
  }
  if (fs.existsSync(TEST_RESOLVER_IDENTITY_FILE)) {
    fs.unlinkSync(TEST_RESOLVER_IDENTITY_FILE);
  }
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
      payload: { input: "draft" },
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
      payload: { input: "draft" },
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
      payload: { input: "draft" },
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

describe("checkpoint forward attachment", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createInForwardReservation(delegationId: string): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  it("attaches one AgentGate action id to an in_forward reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    const attached = attachCheckpointForwardedAction(
      reservationId,
      "ag-checkpoint-001"
    );

    expect(attached.id).toBe(reservationId);
    expect(attached.forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(attached.agentgate_action_id).toBe("ag-checkpoint-001");
    expect(getCheckpointReservationForwardStatus(reservationId)).toEqual({
      action: expect.objectContaining({
        id: reservationId,
        forward_state: CHECKPOINT_FORWARD_STATE_FORWARDED,
        agentgate_action_id: "ag-checkpoint-001",
      }),
      eligible: false,
    });
  });

  it("writes checkpoint_forward_attached once on successful attachment", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");

    const attachedEvents = getEvents(d.id).filter(
      (event) => event.event_type === "checkpoint_forward_attached"
    );

    expect(attachedEvents).toHaveLength(1);
    expect(JSON.parse(attachedEvents[0].detail_json ?? "{}")).toEqual({
      reservation_id: reservationId,
      agentgate_action_id: "ag-checkpoint-001",
      from_forward_state: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      forward_state: CHECKPOINT_FORWARD_STATE_FORWARDED,
    });
  });

  it("rejects attaching a second AgentGate action id", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");

    expect(() =>
      attachCheckpointForwardedAction(reservationId, "ag-checkpoint-002")
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointForwardAttachmentError",
        code: "AGENTGATE_ACTION_ALREADY_ATTACHED",
      })
    );
  });

  it("rejects attaching from pending_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    try {
      attachCheckpointForwardedAction(
        reservation.reservationId,
        "ag-checkpoint-001"
      );
      throw new Error("Expected attachment to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointForwardAttachmentError);
      expect((error as CheckpointForwardAttachmentError).code).toBe(
        "RESERVATION_NOT_IN_FORWARD"
      );
    }
  });

  it("rejects attaching a nonexistent reservation", () => {
    expect(() =>
      attachCheckpointForwardedAction("missing", "ag-checkpoint-001")
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointForwardAttachmentError",
        code: "RESERVATION_NOT_FOUND",
      })
    );
  });
});

describe("checkpoint forward finalization", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createForwardedReservation(delegationId: string): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    attachCheckpointForwardedAction(
      reservation.reservationId,
      "ag-checkpoint-001"
    );

    return reservation.reservationId;
  }

  function expectFinalizationError(run: () => unknown, code: string): void {
    expect(run).toThrowError(
      expect.objectContaining({
        name: "CheckpointForwardFinalizationError",
        code,
      })
    );
  }

  it("finalizes a forwarded reservation as success", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);

    const finalized = finalizeCheckpointForwardedAction(
      reservationId,
      "success"
    );

    expect(finalized.id).toBe(reservationId);
    expect(finalized.forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(finalized.agentgate_action_id).toBe("ag-checkpoint-001");
    expect(finalized.outcome).toBe("success");
    expect(finalized.resolved_at).not.toBeNull();
  });

  it("finalizes a forwarded reservation as failed", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);

    const finalized = finalizeCheckpointForwardedAction(
      reservationId,
      "failed"
    );

    expect(finalized.outcome).toBe("failed");
    expect(finalized.resolved_at).not.toBeNull();
  });

  it("writes checkpoint_forward_finalized once on successful finalization", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);

    finalizeCheckpointForwardedAction(reservationId, "success");

    const finalizedEvents = getEvents(d.id).filter(
      (event) => event.event_type === "checkpoint_forward_finalized"
    );

    expect(finalizedEvents).toHaveLength(1);
    expect(JSON.parse(finalizedEvents[0].detail_json ?? "{}")).toEqual({
      reservation_id: reservationId,
      agentgate_action_id: "ag-checkpoint-001",
      final_outcome: "success",
    });
  });

  it("rejects a second finalization attempt", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);

    finalizeCheckpointForwardedAction(reservationId, "success");

    expectFinalizationError(
      () => finalizeCheckpointForwardedAction(reservationId, "failed"),
      "RESERVATION_ALREADY_FINALIZED"
    );
  });

  it("rejects finalization from pending_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    expectFinalizationError(
      () => finalizeCheckpointForwardedAction(reservation.reservationId, "success"),
      "RESERVATION_NOT_FORWARDED"
    );
  });

  it("rejects finalization from in_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);

    expectFinalizationError(
      () => finalizeCheckpointForwardedAction(reservation.reservationId, "success"),
      "RESERVATION_NOT_FORWARDED"
    );
  });

  it("rejects finalization when forwarded has no attached AgentGate action id", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);

    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    getDb()
      .prepare(
        `UPDATE delegation_actions
         SET forward_state = ?, agentgate_action_id = NULL
         WHERE id = ?`
      )
      .run(CHECKPOINT_FORWARD_STATE_FORWARDED, reservation.reservationId);

    expectFinalizationError(
      () => finalizeCheckpointForwardedAction(reservation.reservationId, "success"),
      "AGENTGATE_ACTION_NOT_ATTACHED"
    );
  });

  it("rejects finalization for a nonexistent reservation", () => {
    expectFinalizationError(
      () => finalizeCheckpointForwardedAction("missing", "success"),
      "RESERVATION_NOT_FOUND"
    );
  });

  it("rejects an invalid checkpoint final outcome", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);

    expectFinalizationError(
      () => finalizeCheckpointForwardedAction(reservationId, "malicious"),
      "INVALID_FINAL_OUTCOME"
    );
  });
});

describe("checkpoint forward failure", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function expectForwardFailureError(run: () => unknown, code: string): void {
    expect(run).toThrowError(
      expect.objectContaining({
        name: "CheckpointForwardFailureError",
        code,
      })
    );
  }

  function createInForwardReservation(delegationId: string): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  it("marks an in_forward reservation as failed before attachment", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    const failed = failCheckpointForwardAttempt(reservationId);

    expect(failed.id).toBe(reservationId);
    expect(failed.forward_state).toBe(CHECKPOINT_FORWARD_STATE_IN_FORWARD);
    expect(failed.agentgate_action_id).toBeNull();
    expect(failed.outcome).toBe("failed");
    expect(failed.resolved_at).not.toBeNull();
  });

  it("writes checkpoint_forward_failed once on failure", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    failCheckpointForwardAttempt(reservationId);

    const failedEvents = getEvents(d.id).filter(
      (event) => event.event_type === "checkpoint_forward_failed"
    );

    expect(failedEvents).toHaveLength(1);
    expect(JSON.parse(failedEvents[0].detail_json ?? "{}")).toEqual({
      reservation_id: reservationId,
      failure_reason: CHECKPOINT_FORWARD_FAILURE_REASON_PRE_ATTACHMENT,
    });
  });

  it("rejects failing a pending_forward reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservation = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    });

    expectForwardFailureError(
      () => failCheckpointForwardAttempt(reservation.reservationId),
      "RESERVATION_NOT_IN_FORWARD"
    );
  });

  it("rejects failing a forwarded reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");

    expectForwardFailureError(
      () => failCheckpointForwardAttempt(reservationId),
      "AGENTGATE_ACTION_ALREADY_ATTACHED"
    );
  });

  it("rejects failing a reservation that already has an attached AgentGate action id", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    getDb()
      .prepare(
        `UPDATE delegation_actions
         SET agentgate_action_id = ?
         WHERE id = ?`
      )
      .run("ag-checkpoint-001", reservationId);

    expectForwardFailureError(
      () => failCheckpointForwardAttempt(reservationId),
      "AGENTGATE_ACTION_ALREADY_ATTACHED"
    );
  });

  it("rejects duplicate fail attempts", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createInForwardReservation(d.id);

    failCheckpointForwardAttempt(reservationId);

    expectForwardFailureError(
      () => failCheckpointForwardAttempt(reservationId),
      "RESERVATION_ALREADY_FINALIZED"
    );
  });
});

describe("checkpoint reservation execution status", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createPendingReservation(delegationId: string): string {
    return reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;
  }

  it("reports pending_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "pending_forward",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_PENDING,
      outcome: null,
      agentgateActionId: null,
      resolvedAt: null,
    });
  });

  it("reports in_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "in_forward",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      outcome: null,
      agentgateActionId: null,
      resolvedAt: null,
    });
  });

  it("reports forwarded", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "forwarded",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
      outcome: null,
      agentgateActionId: "ag-checkpoint-001",
      resolvedAt: null,
    });
  });

  it("reports finalized_success", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");
    finalizeCheckpointForwardedAction(reservationId, "success");

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "finalized_success",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
      outcome: "success",
      agentgateActionId: "ag-checkpoint-001",
      resolvedAt: expect.any(String),
    });
  });

  it("reports finalized_failed", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");
    finalizeCheckpointForwardedAction(reservationId, "failed");

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "finalized_failed",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
      outcome: "failed",
      agentgateActionId: "ag-checkpoint-001",
      resolvedAt: expect.any(String),
    });
  });

  it("reports pre_attachment_failed", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    failCheckpointForwardAttempt(reservationId);

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "pre_attachment_failed",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      outcome: "failed",
      agentgateActionId: null,
      resolvedAt: expect.any(String),
    });
  });

  it("reports not_found for an unknown reservation", () => {
    expect(getCheckpointReservationExecutionStatus("missing")).toEqual({
      status: "not_found",
      reservationId: "missing",
      forwardState: null,
      outcome: null,
      agentgateActionId: null,
      resolvedAt: null,
    });
  });
});

describe("checkpoint execute eligibility", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createPendingReservation(delegationId: string): string {
    return reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;
  }

  it("reports eligible for an in_forward reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: true,
      code: "ELIGIBLE",
    });
  });

  it("reports not eligible for pending_forward", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: false,
      code: "NOT_IN_FORWARD",
    });
  });

  it("reports not eligible for forwarded", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: false,
      code: "ALREADY_FORWARDED",
    });
  });

  it("reports not eligible for finalized_success", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");
    finalizeCheckpointForwardedAction(reservationId, "success");

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: false,
      code: "ALREADY_FINALIZED",
    });
  });

  it("reports not eligible for finalized_failed", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    attachCheckpointForwardedAction(reservationId, "ag-checkpoint-001");
    finalizeCheckpointForwardedAction(reservationId, "failed");

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: false,
      code: "ALREADY_FINALIZED",
    });
  });

  it("reports not eligible for pre_attachment_failed", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createPendingReservation(d.id);

    startCheckpointForwardAttempt(reservationId);
    failCheckpointForwardAttempt(reservationId);

    expect(isCheckpointReservationExecuteEligible(reservationId)).toEqual({
      reservationId,
      eligible: false,
      code: "PRE_ATTACHMENT_FAILED",
    });
  });

  it("reports not eligible for a missing reservation", () => {
    expect(isCheckpointReservationExecuteEligible("missing")).toEqual({
      reservationId: "missing",
      eligible: false,
      code: "NOT_FOUND",
    });
  });
});

describe("checkpoint execute input preparation", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function expectPrepareError(run: () => unknown, code: string): void {
    expect(run).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecutePreparationError",
        code,
      })
    );
  }

  function createExecuteEligibleReservation(
    delegationId: string,
    payload: unknown = { input: "rewrite this draft" }
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload,
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  it("returns the expected prepared input shape for an execute-eligible reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id);

    expect(prepareCheckpointExecuteInput(reservationId)).toEqual({
      reservationId,
      delegationId: d.id,
      delegateId: "agent-pub-key",
      delegateBondId: "agent-bond-456",
      actionType: "email-rewrite",
      payload: { input: "rewrite this draft" },
      declaredExposureCents: 50,
      effectiveExposureCents: 60,
    });
  });

  it("rejects an ineligible reservation clearly", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;

    expectPrepareError(
      () => prepareCheckpointExecuteInput(reservationId),
      "NOT_IN_FORWARD"
    );
  });

  it("rejects a missing reservation clearly", () => {
    expectPrepareError(
      () => prepareCheckpointExecuteInput("missing"),
      "NOT_FOUND"
    );
  });

  it("includes action, payload, exposure, and delegation metadata", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id, {
      file: "draft.txt",
      transform: "rewrite",
    });

    const prepared = prepareCheckpointExecuteInput(reservationId);

    expect(prepared.reservationId).toBe(reservationId);
    expect(prepared.delegationId).toBe(d.id);
    expect(prepared.delegateId).toBe("agent-pub-key");
    expect(prepared.delegateBondId).toBe("agent-bond-456");
    expect(prepared.actionType).toBe("email-rewrite");
    expect(prepared.payload).toEqual({
      file: "draft.txt",
      transform: "rewrite",
    });
    expect(prepared.declaredExposureCents).toBe(50);
    expect(prepared.effectiveExposureCents).toBe(60);
  });
});

describe("checkpoint AgentGate execute request builder", () => {
  it("returns the expected future AgentGate execute request shape", () => {
    expect(
      buildCheckpointAgentGateExecuteRequest({
        reservationId: "res-123",
        delegationId: "del-123",
        delegateId: "delegate-pub-key",
        delegateBondId: "bond-123",
        actionType: "email-rewrite",
        payload: { input: "rewrite this draft" },
        declaredExposureCents: 50,
        effectiveExposureCents: 60,
      })
    ).toEqual({
      identityRef: "delegate-pub-key",
      bondId: "bond-123",
      actionType: "email-rewrite",
      payload: { input: "rewrite this draft" },
      exposure_cents: 50,
    });
  });

  it("preserves actionType, payload, and exposure correctly", () => {
    const request = buildCheckpointAgentGateExecuteRequest({
      reservationId: "res-123",
      delegationId: "del-123",
      delegateId: "delegate-pub-key",
      delegateBondId: "bond-123",
      actionType: "file-transform",
      payload: { file: "draft.txt", transform: "rewrite" },
      declaredExposureCents: 83,
      effectiveExposureCents: 100,
    });

    expect(request.actionType).toBe("file-transform");
    expect(request.payload).toEqual({
      file: "draft.txt",
      transform: "rewrite",
    });
    expect(request.exposure_cents).toBe(83);
  });

  it("rejects incomplete prepared input clearly", () => {
    expect(() =>
      buildCheckpointAgentGateExecuteRequest({
        reservationId: "res-123",
        delegationId: "del-123",
        delegateId: "delegate-pub-key",
        delegateBondId: "",
        actionType: "email-rewrite",
        payload: { input: "rewrite this draft" },
        declaredExposureCents: 50,
        effectiveExposureCents: 60,
      })
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteRequestBuildError",
        code: "MISSING_BOND_ID",
      })
    );
  });
});

describe("checkpoint AgentGate identity resolution", () => {
  it("resolves the final AgentGate identity id from a matching saved identity file", () => {
    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "delegate-pub-key",
        identityId: "agentgate-identity-123",
      })
    );

    expect(
      resolveCheckpointAgentGateIdentityId(
        "delegate-pub-key",
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toBe("agentgate-identity-123");
  });

  it("fails clearly when the checkpoint identity boundary cannot be resolved", () => {
    expect(() =>
      resolveCheckpointAgentGateIdentityId(
        "delegate-pub-key",
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteIdentityResolutionError",
        code: "IDENTITY_FILE_NOT_FOUND",
      })
    );
  });
});

describe("checkpoint AgentGate execute request finalization", () => {
  it("combines the built request and resolved identity id into the final execute body", () => {
    expect(
      finalizeCheckpointAgentGateExecuteRequest(
        {
          identityRef: "delegate-pub-key",
          bondId: "bond-123",
          actionType: "email-rewrite",
          payload: { input: "rewrite this draft" },
          exposure_cents: 50,
        },
        "agentgate-identity-123"
      )
    ).toEqual({
      identityId: "agentgate-identity-123",
      bondId: "bond-123",
      actionType: "email-rewrite",
      payload: { input: "rewrite this draft" },
      exposure_cents: 50,
    });
  });

  it("preserves actionType, payload, exposure_cents, and bondId correctly", () => {
    const body = finalizeCheckpointAgentGateExecuteRequest(
      {
        identityRef: "delegate-pub-key",
        bondId: "bond-789",
        actionType: "file-transform",
        payload: { file: "draft.txt", transform: "rewrite" },
        exposure_cents: 83,
      },
      "agentgate-identity-789"
    );

    expect(body.bondId).toBe("bond-789");
    expect(body.actionType).toBe("file-transform");
    expect(body.payload).toEqual({
      file: "draft.txt",
      transform: "rewrite",
    });
    expect(body.exposure_cents).toBe(83);
  });

  it("rejects a missing resolved identity id clearly", () => {
    expect(() =>
      finalizeCheckpointAgentGateExecuteRequest(
        {
          identityRef: "delegate-pub-key",
          bondId: "bond-123",
          actionType: "email-rewrite",
          payload: { input: "rewrite this draft" },
          exposure_cents: 50,
        },
        ""
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteRequestFinalizationError",
        code: "MISSING_IDENTITY_ID",
      })
    );
  });

  it("rejects an invalid built request clearly", () => {
    expect(() =>
      finalizeCheckpointAgentGateExecuteRequest(
        {
          identityRef: "delegate-pub-key",
          bondId: "",
          actionType: "email-rewrite",
          payload: { input: "rewrite this draft" },
          exposure_cents: 50,
        },
        "agentgate-identity-123"
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteRequestFinalizationError",
        code: "MISSING_BOND_ID",
      })
    );
  });
});

describe("checkpoint AgentGate execute body composition", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createExecuteEligibleReservation(
    delegationId: string,
    payload: unknown = { input: "rewrite this draft" }
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload,
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  it("returns the expected final concrete execute body for a valid reservation and identity file", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id);

    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "agent-pub-key",
        identityId: "agentgate-identity-123",
      })
    );

    expect(
      prepareFinalCheckpointAgentGateExecuteBody(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toEqual({
      identityId: "agentgate-identity-123",
      bondId: "agent-bond-456",
      actionType: "email-rewrite",
      payload: { input: "rewrite this draft" },
      exposure_cents: 50,
    });
  });

  it("preserves actionType, payload, bondId, exposure_cents, and identityId", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id, {
      file: "draft.txt",
      transform: "rewrite",
    });

    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "agent-pub-key",
        identityId: "agentgate-identity-789",
      })
    );

    const body = prepareFinalCheckpointAgentGateExecuteBody(
      reservationId,
      TEST_CHECKPOINT_IDENTITY_FILE
    );

    expect(body.identityId).toBe("agentgate-identity-789");
    expect(body.bondId).toBe("agent-bond-456");
    expect(body.actionType).toBe("email-rewrite");
    expect(body.payload).toEqual({
      file: "draft.txt",
      transform: "rewrite",
    });
    expect(body.exposure_cents).toBe(50);
  });

  it("fails clearly for an ineligible reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;

    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "agent-pub-key",
        identityId: "agentgate-identity-123",
      })
    );

    expect(() =>
      prepareFinalCheckpointAgentGateExecuteBody(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecutePreparationError",
        code: "NOT_IN_FORWARD",
      })
    );
  });

  it("fails clearly when the local identity cannot be resolved", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id);

    expect(() =>
      prepareFinalCheckpointAgentGateExecuteBody(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteIdentityResolutionError",
        code: "IDENTITY_FILE_NOT_FOUND",
      })
    );
  });
});

describe("checkpoint execute readiness", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createExecuteEligibleReservation(
    delegationId: string,
    payload: unknown = { input: "rewrite this draft" }
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload,
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  it("returns ready true with the expected final execute body for an eligible reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id, {
      file: "draft.txt",
      transform: "rewrite",
    });

    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "agent-pub-key",
        identityId: "agentgate-identity-123",
      })
    );

    expect(
      getCheckpointExecuteReadiness(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toEqual({
      ready: true,
      reservationId,
      code: "READY",
      executeBody: {
        identityId: "agentgate-identity-123",
        bondId: "agent-bond-456",
        actionType: "email-rewrite",
        payload: {
          file: "draft.txt",
          transform: "rewrite",
        },
        exposure_cents: 50,
      },
    });
  });

  it("returns ready false with the expected not-ready code for an ineligible reservation", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;

    expect(getCheckpointExecuteReadiness(reservationId)).toEqual({
      ready: false,
      reservationId,
      code: "NOT_IN_FORWARD",
    });
  });

  it("fails in the expected narrow way when the local identity cannot be resolved", () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id);

    expect(() =>
      getCheckpointExecuteReadiness(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).toThrowError(
      expect.objectContaining({
        name: "CheckpointExecuteIdentityResolutionError",
        code: "IDENTITY_FILE_NOT_FOUND",
      })
    );
  });
});

describe("checkpoint execute handoff", () => {
  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createExecuteEligibleReservation(
    delegationId: string,
    payload: unknown = { input: "rewrite this draft" }
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload,
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    return reservation.reservationId;
  }

  function writeCheckpointIdentityFile(identityId = "agentgate-identity-123"): void {
    fs.writeFileSync(
      TEST_CHECKPOINT_IDENTITY_FILE,
      JSON.stringify({
        publicKey: "agent-pub-key",
        privateKey: Buffer.alloc(32, 1).toString("base64"),
        identityId,
      })
    );
  }

  it("successfully calls AgentGate and attaches the returned action id", async () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id, {
      file: "draft.txt",
      transform: "rewrite",
    });
    writeCheckpointIdentityFile();

    const executeSpy = vi
      .spyOn(agentGateClient, "executeBondedAction")
      .mockResolvedValue({ actionId: "ag-checkpoint-001" });

    await expect(
      executeCheckpointForwardHandoff(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).resolves.toEqual({
      ok: true,
      stage: "forwarded",
      reservationId,
      agentgateActionId: "ag-checkpoint-001",
    });

    expect(executeSpy).toHaveBeenCalledWith(
      {
        publicKey: "agent-pub-key",
        privateKey: Buffer.alloc(32, 1).toString("base64"),
      },
      "agentgate-identity-123",
      "agent-bond-456",
      "email-rewrite",
      {
        file: "draft.txt",
        transform: "rewrite",
      },
      50
    );

    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "forwarded",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
      outcome: null,
      agentgateActionId: "ag-checkpoint-001",
      resolvedAt: null,
    });
  });

  it("lands in the pre-attachment failure seam when AgentGate execute fails", async () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createExecuteEligibleReservation(d.id);
    writeCheckpointIdentityFile();

    const executeSpy = vi
      .spyOn(agentGateClient, "executeBondedAction")
      .mockRejectedValue(new Error("AgentGate /v1/actions/execute failed"));

    await expect(
      executeCheckpointForwardHandoff(
        reservationId,
        TEST_CHECKPOINT_IDENTITY_FILE
      )
    ).resolves.toEqual({
      ok: false,
      stage: "pre_attachment_failed",
      reservationId,
      code: "AGENTGATE_EXECUTE_FAILED",
      message: "AgentGate /v1/actions/execute failed",
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "pre_attachment_failed",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      outcome: "failed",
      agentgateActionId: null,
      resolvedAt: expect.any(String),
    });
  });

  it("rejects a non-eligible reservation before making a network call", async () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;

    const executeSpy = vi
      .spyOn(agentGateClient, "executeBondedAction")
      .mockResolvedValue({ actionId: "ag-checkpoint-001" });

    await expect(executeCheckpointForwardHandoff(reservationId)).resolves.toEqual(
      {
        ok: false,
        stage: "not_ready",
        reservationId,
        code: "NOT_IN_FORWARD",
      }
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "pending_forward",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_PENDING,
      outcome: null,
      agentgateActionId: null,
      resolvedAt: null,
    });
  });
});

describe("checkpoint forward resolution bridge", () => {
  const RESOLVER_KEYS = {
    publicKey: "resolver-pub-key",
    privateKey: Buffer.alloc(32, 2).toString("base64"),
  };

  function acceptDelegation(id: string): void {
    claimForAccept(id, "agent-pub-key");
    finalizeAccept(id, "agent-bond-456");
  }

  function createForwardedReservation(
    delegationId: string,
    agentgateActionId = "ag-checkpoint-001"
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "rewrite this draft" },
      declaredExposureCents: 50,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    attachCheckpointForwardedAction(
      reservation.reservationId,
      agentgateActionId
    );

    return reservation.reservationId;
  }

  function writeResolverIdentityFile(
    identityId = "resolver-identity-123"
  ): void {
    fs.writeFileSync(
      TEST_RESOLVER_IDENTITY_FILE,
      JSON.stringify({
        publicKey: RESOLVER_KEYS.publicKey,
        privateKey: RESOLVER_KEYS.privateKey,
        identityId,
      })
    );
  }

  it.each([
    {
      outcome: "success" as const,
      agentgateActionId: "ag-checkpoint-001",
      resolverId: "resolver-identity-123",
      expectedStatus: "finalized_success" as const,
    },
    {
      outcome: "failed" as const,
      agentgateActionId: "ag-checkpoint-002",
      resolverId: "resolver-identity-456",
      expectedStatus: "finalized_failed" as const,
    },
  ])(
    "resolves $outcome through AgentGate and finalizes locally",
    async ({ outcome, agentgateActionId, resolverId, expectedStatus }) => {
      const d = makeTestDelegation();
      acceptDelegation(d.id);
      const reservationId = createForwardedReservation(d.id, agentgateActionId);
      writeResolverIdentityFile(resolverId);

      const resolveSpy = vi
        .spyOn(agentGateClient, "resolveAgentGateAction")
        .mockResolvedValue({ ok: true });

      await expect(
        resolveCheckpointForwardedReservation(
          reservationId,
          outcome,
          TEST_RESOLVER_IDENTITY_FILE
        )
      ).resolves.toEqual({
        ok: true,
        stage: "finalized",
        reservationId,
        agentgateActionId,
        outcome,
      });

      expect(resolveSpy).toHaveBeenCalledWith(
        RESOLVER_KEYS,
        resolverId,
        agentgateActionId,
        outcome
      );

      expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
        status: expectedStatus,
        reservationId,
        forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
        outcome,
        agentgateActionId,
        resolvedAt: expect.any(String),
      });
    }
  );

  it("rejects a non-forwarded reservation", async () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = reserveCheckpointAction({
      delegationId: d.id,
      actorPublicKey: "agent-pub-key",
      actionType: "email-rewrite",
      payload: { input: "draft" },
      declaredExposureCents: 50,
    }).reservationId;

    const resolveSpy = vi
      .spyOn(agentGateClient, "resolveAgentGateAction")
      .mockResolvedValue({ ok: true });

    await expect(
      resolveCheckpointForwardedReservation(
        reservationId,
        "success",
        TEST_RESOLVER_IDENTITY_FILE
      )
    ).resolves.toEqual({
      ok: false,
      stage: "not_ready",
      reservationId,
      code: "NOT_FORWARDED",
    });

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("surfaces AgentGate resolution failure cleanly without orchestration", async () => {
    const d = makeTestDelegation();
    acceptDelegation(d.id);
    const reservationId = createForwardedReservation(d.id);
    writeResolverIdentityFile();

    const resolveSpy = vi
      .spyOn(agentGateClient, "resolveAgentGateAction")
      .mockRejectedValue(new Error("AgentGate resolution failed"));

    await expect(
      resolveCheckpointForwardedReservation(
        reservationId,
        "success",
        TEST_RESOLVER_IDENTITY_FILE
      )
    ).resolves.toEqual({
      ok: false,
      stage: "resolution_failed",
      reservationId,
      agentgateActionId: "ag-checkpoint-001",
      code: "AGENTGATE_RESOLVE_FAILED",
      message: "AgentGate resolution failed",
    });

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(getCheckpointReservationExecutionStatus(reservationId)).toEqual({
      status: "forwarded",
      reservationId,
      forwardState: CHECKPOINT_FORWARD_STATE_FORWARDED,
      outcome: null,
      agentgateActionId: "ag-checkpoint-001",
      resolvedAt: null,
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
