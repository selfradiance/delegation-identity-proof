import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  DelegationScopeSchema,
  effectiveExposure,
  validateAction,
  type DelegationScope,
  type ScopeCheckResult,
} from "./scope";

// --- Types ---

export type DelegationStatus =
  | "pending"
  | "accepting"  // transient: claim during accept two-phase
  | "accepted"
  | "active"
  | "settling"
  | "completed"
  | "failed";

export type TerminalReason =
  | "exhausted"
  | "closed"
  | "revoked"
  | "expired";

export type DelegationOutcome =
  | "success"
  | "failed"
  | "agent-malicious"
  | "none";

export type ActionOutcome = "success" | "failed" | "malicious";
export type CheckpointForwardFinalOutcome = "success" | "failed";
export const CHECKPOINT_FORWARD_STATE_PENDING = "pending_forward" as const;
export const CHECKPOINT_FORWARD_STATE_IN_FORWARD = "in_forward" as const;
export const CHECKPOINT_FORWARD_STATE_FORWARDED = "forwarded" as const;
export type CheckpointForwardState =
  | typeof CHECKPOINT_FORWARD_STATE_PENDING
  | typeof CHECKPOINT_FORWARD_STATE_IN_FORWARD
  | typeof CHECKPOINT_FORWARD_STATE_FORWARDED;

export interface DelegationRow {
  id: string;
  delegator_id: string;
  delegate_id: string;
  scope_json: string;
  delegator_bond_id: string;
  delegate_bond_id: string | null;
  delegator_bond_outcome: string | null;
  delegator_bond_resolved_at: string | null;
  delegation_outcome: string | null;
  status: DelegationStatus;
  terminal_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  expires_at: string;
  completed_at: string | null;
}

export interface DelegationActionRow {
  id: string;
  delegation_id: string;
  agentgate_action_id: string | null;
  forward_state: CheckpointForwardState | null;
  action_type: string;
  declared_exposure_cents: number;
  effective_exposure_cents: number;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DelegationEventRow {
  id: string;
  delegation_id: string;
  event_type: string;
  detail_json: string | null;
  created_at: string;
}

interface ActionSummaryRow {
  action_count: number;
  total_effective_exposure_cents: number | null;
}

// --- Event logging ---

function logEvent(
  delegationId: string,
  eventType: string,
  detail?: Record<string, unknown>
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO delegation_events (id, delegation_id, event_type, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    delegationId,
    eventType,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString()
  );
}

// --- Create delegation ---

export interface CreateDelegationParams {
  delegatorId: string;
  delegateId: string;
  scope: DelegationScope;
  delegatorBondId: string;
  ttlSeconds: number;
}

export function createDelegation(params: CreateDelegationParams): DelegationRow {
  // Validate scope with Zod
  DelegationScopeSchema.parse(params.scope);

  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + params.ttlSeconds * 1000);

  db.prepare(
    `INSERT INTO delegations
     (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    params.delegatorId,
    params.delegateId,
    JSON.stringify(params.scope),
    params.delegatorBondId,
    now.toISOString(),
    expiresAt.toISOString()
  );

  logEvent(id, "delegation_created", {
    delegator_id: params.delegatorId,
    delegate_id: params.delegateId,
    scope: params.scope,
    delegator_bond_id: params.delegatorBondId,
    ttl_seconds: params.ttlSeconds,
  });

  return getDelegation(id)!;
}

// --- Get delegation ---

export function getDelegation(id: string): DelegationRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM delegations WHERE id = ?")
    .get(id) as DelegationRow | undefined;
  return row ?? null;
}

// --- Accept delegation (Phase 1: claim) ---

/**
 * Phase 1 of accept: atomically claim the delegation by moving to 'accepting'.
 * Returns the delegation row if claim succeeded, null if someone else got there first.
 */
export function claimForAccept(
  delegationId: string,
  delegatePublicKey: string
): DelegationRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegations SET status = 'accepting'
     WHERE id = ? AND status = 'pending' AND expires_at > ? AND delegate_id = ?`
  ).run(delegationId, now, delegatePublicKey);

  if (result.changes !== 1) return null;
  return getDelegation(delegationId);
}

/**
 * Phase 3 of accept: finalize after successful AgentGate bond posting.
 */
export function finalizeAccept(
  delegationId: string,
  delegateBondId: string
): DelegationRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegations
     SET status = 'accepted', accepted_at = ?, delegate_bond_id = ?
     WHERE id = ? AND status = 'accepting'`
  ).run(now, delegateBondId, delegationId);

  if (result.changes !== 1) return null;

  logEvent(delegationId, "delegation_accepted", {
    delegate_bond_id: delegateBondId,
  });

  return getDelegation(delegationId);
}

/**
 * Phase 3 of accept: revert after failed AgentGate bond posting.
 */
export function revertAccept(delegationId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE delegations SET status = 'pending'
     WHERE id = ? AND status = 'accepting'`
  ).run(delegationId);
}

// --- Act under delegation (Phase 1: validate and reserve) ---

export interface ActParams {
  delegationId: string;
  actorPublicKey: string;
  actionType: string;
  declaredExposureCents: number;
}

export interface ActReservation {
  actionId: string;
  delegation: DelegationRow;
}

export interface CheckpointReservationParams {
  delegationId: string;
  actorPublicKey: string;
  actionType: string;
  declaredExposureCents: number;
}

export interface CheckpointReservationResult {
  reservationId: string;
  delegation: DelegationRow;
  forwardState: CheckpointForwardState;
}

export interface CheckpointForwardStatus {
  action: DelegationActionRow;
  eligible: boolean;
}

export class CheckpointReservationError extends Error {
  code:
    | "DELEGATION_NOT_FOUND"
    | "DELEGATE_MISMATCH"
    | "ACTION_TYPE_NOT_ALLOWED"
    | "MAX_ACTIONS_EXCEEDED"
    | "PER_ACTION_EXPOSURE_EXCEEDED"
    | "MAX_TOTAL_EXPOSURE_EXCEEDED"
    | "RESERVATION_FAILED";

  constructor(
    code:
      | "DELEGATION_NOT_FOUND"
      | "DELEGATE_MISMATCH"
      | "ACTION_TYPE_NOT_ALLOWED"
      | "MAX_ACTIONS_EXCEEDED"
      | "PER_ACTION_EXPOSURE_EXCEEDED"
      | "MAX_TOTAL_EXPOSURE_EXCEEDED"
      | "RESERVATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointReservationError";
    this.code = code;
  }
}

export class CheckpointForwardTransitionError extends Error {
  code:
    | "RESERVATION_NOT_FOUND"
    | "RESERVATION_NOT_FORWARDABLE"
    | "FORWARD_TRANSITION_FAILED";

  constructor(
    code:
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_NOT_FORWARDABLE"
      | "FORWARD_TRANSITION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointForwardTransitionError";
    this.code = code;
  }
}

export class CheckpointForwardAttachmentError extends Error {
  code:
    | "RESERVATION_NOT_FOUND"
    | "RESERVATION_NOT_IN_FORWARD"
    | "AGENTGATE_ACTION_ALREADY_ATTACHED"
    | "FORWARD_ATTACHMENT_FAILED";

  constructor(
    code:
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_NOT_IN_FORWARD"
      | "AGENTGATE_ACTION_ALREADY_ATTACHED"
      | "FORWARD_ATTACHMENT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointForwardAttachmentError";
    this.code = code;
  }
}

export class CheckpointForwardFinalizationError extends Error {
  code:
    | "RESERVATION_NOT_FOUND"
    | "RESERVATION_NOT_FORWARDED"
    | "AGENTGATE_ACTION_NOT_ATTACHED"
    | "RESERVATION_ALREADY_FINALIZED"
    | "INVALID_FINAL_OUTCOME"
    | "FORWARD_FINALIZATION_FAILED";

  constructor(
    code:
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_NOT_FORWARDED"
      | "AGENTGATE_ACTION_NOT_ATTACHED"
      | "RESERVATION_ALREADY_FINALIZED"
      | "INVALID_FINAL_OUTCOME"
      | "FORWARD_FINALIZATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointForwardFinalizationError";
    this.code = code;
  }
}

export function reserveCheckpointAction(
  params: CheckpointReservationParams
): CheckpointReservationResult {
  const db = getDb();
  const reserve = db.transaction((txParams: CheckpointReservationParams) => {
    const delegation = db
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get(txParams.delegationId) as DelegationRow | undefined;

    if (!delegation) {
      throw new CheckpointReservationError(
        "DELEGATION_NOT_FOUND",
        "Delegation not found"
      );
    }

    if (delegation.delegate_id !== txParams.actorPublicKey) {
      throw new CheckpointReservationError(
        "DELEGATE_MISMATCH",
        "Only the bound delegate can reserve checkpoint actions"
      );
    }

    const scope: DelegationScope = JSON.parse(delegation.scope_json);
    const effective = effectiveExposure(txParams.declaredExposureCents);
    const maxPerActionEffective = effectiveExposure(scope.max_exposure_cents);

    if (!scope.allowed_actions.includes(txParams.actionType)) {
      throw new CheckpointReservationError(
        "ACTION_TYPE_NOT_ALLOWED",
        `Action type "${txParams.actionType}" is outside delegated scope`
      );
    }

    // For Baby Step 4, all existing rows in delegation_actions for this
    // delegation count toward max_actions and total exposure. That includes
    // prior checkpoint reservations and any later execution rows because the
    // finalize/revert split is not introduced yet.
    const summary = db
      .prepare(
        `SELECT
           COUNT(*) as action_count,
           COALESCE(SUM(effective_exposure_cents), 0) as total_effective_exposure_cents
         FROM delegation_actions
         WHERE delegation_id = ?`
      )
      .get(txParams.delegationId) as ActionSummaryRow;

    if (summary.action_count >= scope.max_actions) {
      throw new CheckpointReservationError(
        "MAX_ACTIONS_EXCEEDED",
        `Creating another reservation would exceed max_actions ${scope.max_actions}`
      );
    }

    if (
      txParams.declaredExposureCents > scope.max_exposure_cents ||
      effective > maxPerActionEffective
    ) {
      throw new CheckpointReservationError(
        "PER_ACTION_EXPOSURE_EXCEEDED",
        `Declared exposure ${txParams.declaredExposureCents}¢ / effective exposure ${effective}¢ exceeds per-action limit ${scope.max_exposure_cents}¢ / ${maxPerActionEffective}¢ effective`
      );
    }

    const projectedTotal =
      (summary.total_effective_exposure_cents ?? 0) + effective;
    if (projectedTotal > scope.max_total_exposure_cents) {
      throw new CheckpointReservationError(
        "MAX_TOTAL_EXPOSURE_EXCEEDED",
        `Projected total effective exposure ${projectedTotal}¢ exceeds max_total_exposure_cents ${scope.max_total_exposure_cents}¢`
      );
    }

    const reservationId = randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO delegation_actions
       (id, delegation_id, forward_state, action_type, declared_exposure_cents, effective_exposure_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reservationId,
      txParams.delegationId,
      CHECKPOINT_FORWARD_STATE_PENDING,
      txParams.actionType,
      txParams.declaredExposureCents,
      effective,
      now
    );

    logEvent(txParams.delegationId, "checkpoint_action_reserved", {
      reservation_id: reservationId,
      forward_state: CHECKPOINT_FORWARD_STATE_PENDING,
      delegate_id: txParams.actorPublicKey,
      action_type: txParams.actionType,
      declared_exposure_cents: txParams.declaredExposureCents,
      effective_exposure_cents: effective,
    });

    return {
      reservationId,
      delegation,
      forwardState: CHECKPOINT_FORWARD_STATE_PENDING,
    };
  });

  try {
    return reserve.immediate(params);
  } catch (error) {
    if (error instanceof CheckpointReservationError) {
      throw error;
    }

    throw new CheckpointReservationError(
      "RESERVATION_FAILED",
      "Failed to create local checkpoint reservation"
    );
  }
}

export function getCheckpointReservationForwardStatus(
  reservationId: string
): CheckpointForwardStatus | null {
  const db = getDb();
  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(reservationId) as DelegationActionRow | undefined;

  if (!action) return null;

  return {
    action,
    eligible:
      action.forward_state === CHECKPOINT_FORWARD_STATE_PENDING &&
      action.agentgate_action_id === null &&
      action.outcome === null,
  };
}

export function startCheckpointForwardAttempt(
  reservationId: string
): DelegationActionRow {
  const db = getDb();
  const startForward = db.transaction((txReservationId: string) => {
    const action = db
      .prepare("SELECT * FROM delegation_actions WHERE id = ?")
      .get(txReservationId) as DelegationActionRow | undefined;

    if (!action) {
      throw new CheckpointForwardTransitionError(
        "RESERVATION_NOT_FOUND",
        "Checkpoint reservation not found"
      );
    }

    const eligible =
      action.forward_state === CHECKPOINT_FORWARD_STATE_PENDING &&
      action.agentgate_action_id === null &&
      action.outcome === null;

    if (!eligible) {
      throw new CheckpointForwardTransitionError(
        "RESERVATION_NOT_FORWARDABLE",
        "Checkpoint reservation is not eligible to start a forward attempt"
      );
    }

    const result = db.prepare(
      `UPDATE delegation_actions
       SET forward_state = ?
       WHERE id = ? AND forward_state = ? AND agentgate_action_id IS NULL AND outcome IS NULL`
    ).run(
      CHECKPOINT_FORWARD_STATE_IN_FORWARD,
      txReservationId,
      CHECKPOINT_FORWARD_STATE_PENDING
    );

    if (result.changes !== 1) {
      throw new CheckpointForwardTransitionError(
        "FORWARD_TRANSITION_FAILED",
        "Failed to start checkpoint forward attempt"
      );
    }

    logEvent(action.delegation_id, "checkpoint_forward_started", {
      reservation_id: txReservationId,
      from_forward_state: CHECKPOINT_FORWARD_STATE_PENDING,
      forward_state: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
    });

    return db
      .prepare("SELECT * FROM delegation_actions WHERE id = ?")
      .get(txReservationId) as DelegationActionRow;
  });

  try {
    return startForward.immediate(reservationId);
  } catch (error) {
    if (error instanceof CheckpointForwardTransitionError) {
      throw error;
    }

    throw new CheckpointForwardTransitionError(
      "FORWARD_TRANSITION_FAILED",
      "Failed to start checkpoint forward attempt"
    );
  }
}

export function attachCheckpointForwardedAction(
  reservationId: string,
  agentgateActionId: string
): DelegationActionRow {
  const db = getDb();
  const attachForwardedAction = db.transaction(
    (txReservationId: string, txAgentgateActionId: string) => {
      const action = db
        .prepare("SELECT * FROM delegation_actions WHERE id = ?")
        .get(txReservationId) as DelegationActionRow | undefined;

      if (!action) {
        throw new CheckpointForwardAttachmentError(
          "RESERVATION_NOT_FOUND",
          "Checkpoint reservation not found"
        );
      }

      if (action.agentgate_action_id !== null) {
        throw new CheckpointForwardAttachmentError(
          "AGENTGATE_ACTION_ALREADY_ATTACHED",
          "Checkpoint reservation already has an attached AgentGate action id"
        );
      }

      if (action.forward_state !== CHECKPOINT_FORWARD_STATE_IN_FORWARD) {
        throw new CheckpointForwardAttachmentError(
          "RESERVATION_NOT_IN_FORWARD",
          "Checkpoint reservation is not currently in_forward"
        );
      }

      const result = db.prepare(
        `UPDATE delegation_actions
         SET agentgate_action_id = ?, forward_state = ?
         WHERE id = ? AND forward_state = ? AND agentgate_action_id IS NULL AND outcome IS NULL`
      ).run(
        txAgentgateActionId,
        CHECKPOINT_FORWARD_STATE_FORWARDED,
        txReservationId,
        CHECKPOINT_FORWARD_STATE_IN_FORWARD
      );

      if (result.changes !== 1) {
        throw new CheckpointForwardAttachmentError(
          "FORWARD_ATTACHMENT_FAILED",
          "Failed to attach AgentGate action id to checkpoint reservation"
        );
      }

      logEvent(action.delegation_id, "checkpoint_forward_attached", {
        reservation_id: txReservationId,
        agentgate_action_id: txAgentgateActionId,
        from_forward_state: CHECKPOINT_FORWARD_STATE_IN_FORWARD,
        forward_state: CHECKPOINT_FORWARD_STATE_FORWARDED,
      });

      return db
        .prepare("SELECT * FROM delegation_actions WHERE id = ?")
        .get(txReservationId) as DelegationActionRow;
    }
  );

  try {
    return attachForwardedAction.immediate(reservationId, agentgateActionId);
  } catch (error) {
    if (error instanceof CheckpointForwardAttachmentError) {
      throw error;
    }

    throw new CheckpointForwardAttachmentError(
      "FORWARD_ATTACHMENT_FAILED",
      "Failed to attach AgentGate action id to checkpoint reservation"
    );
  }
}

export function finalizeCheckpointForwardedAction(
  reservationId: string,
  outcome: string
): DelegationActionRow {
  const db = getDb();
  const finalizeForwardedAction = db.transaction(
    (txReservationId: string, txOutcome: string) => {
      if (txOutcome !== "success" && txOutcome !== "failed") {
        throw new CheckpointForwardFinalizationError(
          "INVALID_FINAL_OUTCOME",
          `Unsupported checkpoint final outcome "${txOutcome}"`
        );
      }

      const action = db
        .prepare("SELECT * FROM delegation_actions WHERE id = ?")
        .get(txReservationId) as DelegationActionRow | undefined;

      if (!action) {
        throw new CheckpointForwardFinalizationError(
          "RESERVATION_NOT_FOUND",
          "Checkpoint reservation not found"
        );
      }

      if (action.outcome !== null || action.resolved_at !== null) {
        throw new CheckpointForwardFinalizationError(
          "RESERVATION_ALREADY_FINALIZED",
          "Checkpoint reservation is already finalized"
        );
      }

      if (action.forward_state !== CHECKPOINT_FORWARD_STATE_FORWARDED) {
        throw new CheckpointForwardFinalizationError(
          "RESERVATION_NOT_FORWARDED",
          "Checkpoint reservation is not currently forwarded"
        );
      }

      if (action.agentgate_action_id === null) {
        throw new CheckpointForwardFinalizationError(
          "AGENTGATE_ACTION_NOT_ATTACHED",
          "Checkpoint reservation has no attached AgentGate action id"
        );
      }

      const now = new Date().toISOString();
      const result = db.prepare(
        `UPDATE delegation_actions
         SET outcome = ?, resolved_at = ?
         WHERE id = ? AND forward_state = ? AND agentgate_action_id IS NOT NULL AND outcome IS NULL AND resolved_at IS NULL`
      ).run(
        txOutcome,
        now,
        txReservationId,
        CHECKPOINT_FORWARD_STATE_FORWARDED
      );

      if (result.changes !== 1) {
        throw new CheckpointForwardFinalizationError(
          "FORWARD_FINALIZATION_FAILED",
          "Failed to finalize forwarded checkpoint reservation"
        );
      }

      logEvent(action.delegation_id, "checkpoint_forward_finalized", {
        reservation_id: txReservationId,
        agentgate_action_id: action.agentgate_action_id,
        final_outcome: txOutcome,
      });

      return db
        .prepare("SELECT * FROM delegation_actions WHERE id = ?")
        .get(txReservationId) as DelegationActionRow;
    }
  );

  try {
    return finalizeForwardedAction.immediate(reservationId, outcome);
  } catch (error) {
    if (error instanceof CheckpointForwardFinalizationError) {
      throw error;
    }

    throw new CheckpointForwardFinalizationError(
      "FORWARD_FINALIZATION_FAILED",
      "Failed to finalize forwarded checkpoint reservation"
    );
  }
}

/**
 * Phase 1 of act: validate scope and reserve an action slot.
 * Returns the action ID and delegation if valid, or a ScopeCheckResult if rejected.
 */
export function reserveAction(
  params: ActParams
): ActReservation | ScopeCheckResult {
  const db = getDb();
  const reserve = db.transaction((txParams: ActParams) => {
    const delegation = db
      .prepare("SELECT * FROM delegations WHERE id = ?")
      .get(txParams.delegationId) as DelegationRow | undefined;

    if (!delegation) {
      return { valid: false, reason: "Delegation not found" };
    }

    if (delegation.delegate_id !== txParams.actorPublicKey) {
      return {
        valid: false,
        reason: "Only the delegated agent can act on this delegation",
      };
    }

    // Guard: status must be accepted or active
    if (delegation.status !== "accepted" && delegation.status !== "active") {
      return {
        valid: false,
        reason: `Cannot act on delegation with status "${delegation.status}"`,
      };
    }

    // Guard: check expiry inside critical section
    const now = new Date().toISOString();
    if (now >= delegation.expires_at) {
      logEvent(txParams.delegationId, "action_rejected_expired", {
        action_type: txParams.actionType,
        declared_exposure_cents: txParams.declaredExposureCents,
      });
      return { valid: false, reason: "Delegation has expired" };
    }

    // Get scope and validate.
    const scope: DelegationScope = JSON.parse(delegation.scope_json);
    const summary = db
      .prepare(
        `SELECT
           COUNT(*) as action_count,
           COALESCE(SUM(effective_exposure_cents), 0) as total_effective_exposure_cents
         FROM delegation_actions
         WHERE delegation_id = ?`
      )
      .get(txParams.delegationId) as ActionSummaryRow;

    const scopeCheck = validateAction(
      scope,
      txParams.actionType,
      txParams.declaredExposureCents,
      summary.action_count,
      summary.total_effective_exposure_cents ?? 0
    );

    if (!scopeCheck.valid) {
      logEvent(txParams.delegationId, "action_rejected_scope", {
        action_type: txParams.actionType,
        declared_exposure_cents: txParams.declaredExposureCents,
        reason: scopeCheck.reason,
      });
      return scopeCheck;
    }

    // Reserve action slot before leaving the transaction so concurrent callers
    // see this reservation in max_actions and total exposure calculations.
    const actionId = randomUUID();
    const effective = effectiveExposure(txParams.declaredExposureCents);

    db.prepare(
      `INSERT INTO delegation_actions
       (id, delegation_id, action_type, declared_exposure_cents, effective_exposure_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      actionId,
      txParams.delegationId,
      txParams.actionType,
      txParams.declaredExposureCents,
      effective,
      now
    );

    return { actionId, delegation };
  });

  return reserve.immediate(params);
}

/**
 * Phase 3 of act: finalize after successful AgentGate execute_bonded_action.
 */
export function finalizeAction(
  actionId: string,
  delegationId: string,
  agentgateActionId: string
): void {
  const db = getDb();
  const finalize = db.transaction(
    (txActionId: string, txDelegationId: string, txAgentgateActionId: string) => {
      const action = db
        .prepare(
          `SELECT delegation_id FROM delegation_actions
           WHERE id = ? AND agentgate_action_id IS NULL`
        )
        .get(txActionId) as { delegation_id: string } | undefined;

      if (!action || action.delegation_id !== txDelegationId) {
        return;
      }

      db.prepare(
        `UPDATE delegation_actions SET agentgate_action_id = ?
         WHERE id = ? AND agentgate_action_id IS NULL`
      ).run(txAgentgateActionId, txActionId);

      // Move delegation to active if it was accepted. Settling/completed
      // delegations keep their current state when an in-flight action finalizes.
      db.prepare(
        `UPDATE delegations SET status = 'active'
         WHERE id = ? AND status IN ('accepted', 'active')`
      ).run(txDelegationId);

      logEvent(txDelegationId, "action_executed", {
        action_id: txActionId,
        agentgate_action_id: txAgentgateActionId,
      });
    }
  );

  finalize.immediate(actionId, delegationId, agentgateActionId);
}

/**
 * Phase 3 of act: revert after failed AgentGate call.
 */
export function revertAction(actionId: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM delegation_actions WHERE id = ? AND agentgate_action_id IS NULL"
  ).run(actionId);
}

// --- Resolve action ---

export function resolveAction(
  actionId: string,
  outcome: ActionOutcome
): DelegationActionRow | null {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    `UPDATE delegation_actions SET outcome = ?, resolved_at = ?
     WHERE id = ? AND outcome IS NULL`
  ).run(outcome, now, actionId);

  if (result.changes !== 1) return null;

  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(actionId) as DelegationActionRow;

  logEvent(action.delegation_id, "action_resolved", {
    action_id: actionId,
    outcome,
  });

  // Check if delegation should auto-complete
  tryAutoComplete(action.delegation_id);

  return action;
}

// --- Revoke delegation ---

export function revokeDelegation(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  // Guard: cannot revoke terminal or transient states
  if (
    delegation.status === "settling" ||
    delegation.status === "completed" ||
    delegation.status === "failed" ||
    delegation.status === "accepting"
  ) {
    return null;
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Check for open (unresolved) actions
  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) {
    // Move to settling — actions still need resolution
    const result = db.prepare(
      `UPDATE delegations SET status = 'settling', terminal_reason = 'revoked'
       WHERE id = ? AND status IN ('pending', 'accepted', 'active')`
    ).run(delegationId);

    if (result.changes !== 1) return null;

    logEvent(delegationId, "delegation_revoked", { settling: true });
  } else {
    // No open actions — go straight to completed
    const outcome = computeOutcome(delegationId);
    const result = db.prepare(
      `UPDATE delegations
       SET status = 'completed', terminal_reason = 'revoked',
           delegation_outcome = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'accepted', 'active')`
    ).run(outcome, now, delegationId);

    if (result.changes !== 1) return null;

    logEvent(delegationId, "delegation_revoked", { settling: false });
    logEvent(delegationId, "delegation_completed", {
      outcome,
      reason: "revoked",
    });
  }

  return getDelegation(delegationId);
}

// --- Close delegation ---

export function closeDelegation(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  // Guard: can only close active delegations with zero open actions
  if (delegation.status !== "active") return null;

  const db = getDb();

  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) return null;

  const now = new Date().toISOString();
  const outcome = computeOutcome(delegationId);

  const result = db.prepare(
    `UPDATE delegations
     SET status = 'completed', terminal_reason = 'closed',
         delegation_outcome = ?, completed_at = ?
     WHERE id = ? AND status = 'active'`
  ).run(outcome, now, delegationId);

  if (result.changes !== 1) return null;

  logEvent(delegationId, "delegation_completed", {
    outcome,
    reason: "closed",
  });

  return getDelegation(delegationId);
}

// --- Expiry check ---

export function checkExpiry(delegationId: string): DelegationRow | null {
  const delegation = getDelegation(delegationId);
  if (!delegation) return null;

  const now = new Date().toISOString();
  if (now < delegation.expires_at) return null; // not expired yet

  // Only expire non-terminal, non-transient delegations
  if (
    delegation.status === "settling" ||
    delegation.status === "completed" ||
    delegation.status === "failed" ||
    delegation.status === "accepting"
  ) {
    return null;
  }

  const db = getDb();

  const openActions = db
    .prepare(
      `SELECT COUNT(*) as count FROM delegation_actions
       WHERE delegation_id = ? AND outcome IS NULL`
    )
    .get(delegationId) as { count: number };

  if (openActions.count > 0) {
    const result = db.prepare(
      `UPDATE delegations SET status = 'settling', terminal_reason = 'expired'
       WHERE id = ? AND status IN ('pending', 'accepted', 'active')`
    ).run(delegationId);

    if (result.changes !== 1) return null;

    logEvent(delegationId, "delegation_expired", { settling: true });
  } else {
    const outcome = computeOutcome(delegationId);
    const result = db.prepare(
      `UPDATE delegations
       SET status = 'completed', terminal_reason = 'expired',
           delegation_outcome = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'accepted', 'active')`
    ).run(outcome, now, delegationId);

    if (result.changes !== 1) return null;

    logEvent(delegationId, "delegation_expired", { settling: false });
    logEvent(delegationId, "delegation_completed", {
      outcome,
      reason: "expired",
    });
  }

  return getDelegation(delegationId);
}

// --- Aggregate outcome computation ---

export function computeOutcome(delegationId: string): DelegationOutcome {
  const db = getDb();
  const actions = db
    .prepare("SELECT * FROM delegation_actions WHERE delegation_id = ?")
    .all(delegationId) as DelegationActionRow[];

  if (actions.length === 0) return "none";
  if (actions.some((a) => a.outcome === null)) return "none";

  const hasMalicious = actions.some((a) => a.outcome === "malicious");
  if (hasMalicious) return "agent-malicious";

  const hasFailed = actions.some((a) => a.outcome === "failed");
  if (hasFailed) return "failed";

  const allSuccess = actions.every((a) => a.outcome === "success");
  if (allSuccess) return "success";

  // Some actions still unresolved — shouldn't happen at completion time
  // but return "none" as safe default
  return "none";
}

// --- Auto-complete check ---

function tryAutoComplete(delegationId: string): void {
  const delegation = getDelegation(delegationId);
  if (!delegation) return;

  const db = getDb();

  // Auto-complete settling delegations when all actions are resolved
  if (delegation.status === "settling") {
    const openActions = db
      .prepare(
        `SELECT COUNT(*) as count FROM delegation_actions
         WHERE delegation_id = ? AND outcome IS NULL`
      )
      .get(delegationId) as { count: number };

    if (openActions.count === 0) {
      const now = new Date().toISOString();
      const outcome = computeOutcome(delegationId);
      const result = db.prepare(
        `UPDATE delegations
         SET status = 'completed', delegation_outcome = ?, completed_at = ?
         WHERE id = ? AND status = 'settling'`
      ).run(outcome, now, delegationId);

      if (result.changes !== 1) return;

      logEvent(delegationId, "delegation_completed", {
        outcome,
        reason: delegation.terminal_reason,
      });
    }
  }

  // Auto-complete active delegations when all max_actions are exhausted and resolved
  if (delegation.status === "active") {
    const scope: DelegationScope = JSON.parse(delegation.scope_json);
    const actions = db
      .prepare("SELECT * FROM delegation_actions WHERE delegation_id = ?")
      .all(delegationId) as DelegationActionRow[];

    if (actions.length >= scope.max_actions) {
      const allResolved = actions.every((a) => a.outcome !== null);
      if (allResolved) {
        const now = new Date().toISOString();
        const outcome = computeOutcome(delegationId);
        const result = db.prepare(
          `UPDATE delegations
           SET status = 'completed', terminal_reason = 'exhausted',
               delegation_outcome = ?, completed_at = ?
           WHERE id = ? AND status = 'active'`
        ).run(outcome, now, delegationId);

        if (result.changes !== 1) return;

        logEvent(delegationId, "delegation_completed", {
          outcome,
          reason: "exhausted",
        });
      }
    }
  }
}

// --- Recovery: revert transient states on startup ---

export function recoverTransientStates(): number {
  const db = getDb();
  const now = new Date().toISOString();
  let recovered = 0;

  const recover = db.transaction(() => {
    const acceptResult = db.prepare(
      `UPDATE delegations SET status = 'pending'
       WHERE status = 'accepting'`
    ).run();
    recovered += acceptResult.changes;

    const indeterminateDelegations = db
      .prepare(
        `SELECT DISTINCT delegation_id
         FROM delegation_actions
         WHERE agentgate_action_id IS NULL`
      )
      .all() as { delegation_id: string }[];

    const markFailed = db.prepare(
      `UPDATE delegations
       SET status = 'failed'
       WHERE id = ? AND status IN ('pending', 'accepted', 'active', 'settling')`
    );

    for (const row of indeterminateDelegations) {
      const result = markFailed.run(row.delegation_id);
      if (result.changes === 1) {
        recovered += 1;
        logEvent(row.delegation_id, "delegation_recovery_failed", {
          reason: "orphaned_local_action_reservation",
          detected_at: now,
        });
      }
    }
  });

  recover.immediate();
  return recovered;
}

// --- Query helpers ---

export function getActions(
  delegationId: string
): DelegationActionRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM delegation_actions WHERE delegation_id = ? ORDER BY created_at"
    )
    .all(delegationId) as DelegationActionRow[];
}

export function getEvents(
  delegationId: string
): DelegationEventRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM delegation_events WHERE delegation_id = ? ORDER BY created_at"
    )
    .all(delegationId) as DelegationEventRow[];
}
