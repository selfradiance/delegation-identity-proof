import { randomUUID } from "crypto";
import * as agentGateClient from "./agentgate-client";
import { getDb } from "./db";
import {
  DelegationScopeSchema,
  effectiveExposure,
  validateAction,
  type DelegationScope,
  type ScopeCheckResult,
} from "./scope";
import { appendTransparencyLogRow } from "./transparency-log";

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
export const CHECKPOINT_FORWARD_FAILURE_REASON_PRE_ATTACHMENT =
  "pre_attachment_forward_failed" as const;
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
  payload_json: string | null;
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
  appendTransparencyLogRow({
    delegationId: id,
    eventType: "delegation_created",
    actorKind: "delegator",
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
  appendTransparencyLogRow({
    delegationId,
    eventType: "delegation_accepted",
    actorKind: "delegate",
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
  payload: unknown;
  declaredExposureCents: number;
  appendExecuteTransparencyRows?: boolean;
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

export type CheckpointReservationExecutionState =
  | "pending_forward"
  | "in_forward"
  | "forwarded"
  | "finalized_success"
  | "finalized_failed"
  | "pre_attachment_failed"
  | "not_found";

export interface CheckpointReservationExecutionStatus {
  status: CheckpointReservationExecutionState;
  reservationId: string;
  forwardState: CheckpointForwardState | null;
  outcome: string | null;
  agentgateActionId: string | null;
  resolvedAt: string | null;
}

export type CheckpointReservationExecuteEligibilityCode =
  | "ELIGIBLE"
  | "NOT_FOUND"
  | "NOT_IN_FORWARD"
  | "ALREADY_FORWARDED"
  | "ALREADY_FINALIZED"
  | "PRE_ATTACHMENT_FAILED";

export interface CheckpointReservationExecuteEligibility {
  reservationId: string;
  eligible: boolean;
  code: CheckpointReservationExecuteEligibilityCode;
}

export type CheckpointExecuteReadinessCode =
  | "READY"
  | Exclude<CheckpointReservationExecuteEligibilityCode, "ELIGIBLE">;

export interface CheckpointExecuteReadiness {
  ready: boolean;
  reservationId: string;
  code: CheckpointExecuteReadinessCode;
  executeBody?: CheckpointAgentGateExecuteRequestBody;
}

export type CheckpointExecuteHandoffResult =
  | {
      ok: true;
      stage: "forwarded";
      reservationId: string;
      agentgateActionId: string;
    }
  | {
      ok: false;
      stage: "not_ready";
      reservationId: string;
      code: Exclude<CheckpointExecuteReadinessCode, "READY">;
    }
  | {
      ok: false;
      stage: "pre_attachment_failed";
      reservationId: string;
      code: "AGENTGATE_EXECUTE_FAILED";
      message: string;
    };

export type CheckpointForwardResolutionNotReadyCode =
  | "NOT_FOUND"
  | "NOT_FORWARDED"
  | "AGENTGATE_ACTION_NOT_ATTACHED"
  | "ALREADY_FINALIZED"
  | "PRE_ATTACHMENT_FAILED";

export type CheckpointForwardResolutionResult =
  | {
      ok: true;
      stage: "finalized";
      reservationId: string;
      agentgateActionId: string;
      outcome: CheckpointForwardFinalOutcome;
    }
  | {
      ok: false;
      stage: "not_ready";
      reservationId: string;
      code: CheckpointForwardResolutionNotReadyCode;
    }
  | {
      ok: false;
      stage: "resolution_failed";
      reservationId: string;
      agentgateActionId: string;
      code: "AGENTGATE_RESOLVE_FAILED";
      message: string;
    };

export interface CheckpointPreparedExecuteInput {
  reservationId: string;
  delegationId: string;
  delegateId: string;
  delegateBondId: string;
  actionType: string;
  payload: unknown;
  declaredExposureCents: number;
  effectiveExposureCents: number;
}

export interface CheckpointAgentGateExecuteRequest {
  // The future execute path resolves this bound delegate reference to the
  // AgentGate identityId immediately before the real network call.
  identityRef: string;
  bondId: string;
  actionType: string;
  payload: unknown;
  exposure_cents: number;
}

export interface CheckpointAgentGateExecuteRequestBody {
  identityId: string;
  bondId: string;
  actionType: string;
  payload: unknown;
  exposure_cents: number;
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

export class CheckpointExecutePreparationError extends Error {
  code:
    | CheckpointReservationExecuteEligibilityCode
    | "DELEGATION_NOT_FOUND"
    | "DELEGATE_BOND_NOT_FOUND"
    | "PAYLOAD_NOT_RECORDED"
    | "PREPARE_INPUT_FAILED";

  constructor(
    code:
      | CheckpointReservationExecuteEligibilityCode
      | "DELEGATION_NOT_FOUND"
      | "DELEGATE_BOND_NOT_FOUND"
      | "PAYLOAD_NOT_RECORDED"
      | "PREPARE_INPUT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointExecutePreparationError";
    this.code = code;
  }
}

export class CheckpointExecuteRequestBuildError extends Error {
  code:
    | "MISSING_IDENTITY_REF"
    | "MISSING_BOND_ID"
    | "INVALID_ACTION_TYPE"
    | "INVALID_EXPOSURE"
    | "BUILD_REQUEST_FAILED";

  constructor(
    code:
      | "MISSING_IDENTITY_REF"
      | "MISSING_BOND_ID"
      | "INVALID_ACTION_TYPE"
      | "INVALID_EXPOSURE"
      | "BUILD_REQUEST_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointExecuteRequestBuildError";
    this.code = code;
  }
}

export class CheckpointExecuteIdentityResolutionError extends Error {
  code:
    | "MISSING_IDENTITY_REF"
    | "IDENTITY_FILE_NOT_FOUND"
    | "IDENTITY_REF_MISMATCH"
    | "IDENTITY_ID_NOT_FOUND"
    | "IDENTITY_RESOLUTION_FAILED";

  constructor(
    code:
      | "MISSING_IDENTITY_REF"
      | "IDENTITY_FILE_NOT_FOUND"
      | "IDENTITY_REF_MISMATCH"
      | "IDENTITY_ID_NOT_FOUND"
      | "IDENTITY_RESOLUTION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointExecuteIdentityResolutionError";
    this.code = code;
  }
}

export class CheckpointExecuteRequestFinalizationError extends Error {
  code:
    | "MISSING_IDENTITY_ID"
    | "MISSING_IDENTITY_REF"
    | "MISSING_BOND_ID"
    | "INVALID_ACTION_TYPE"
    | "INVALID_EXPOSURE"
    | "FINALIZE_REQUEST_FAILED";

  constructor(
    code:
      | "MISSING_IDENTITY_ID"
      | "MISSING_IDENTITY_REF"
      | "MISSING_BOND_ID"
      | "INVALID_ACTION_TYPE"
      | "INVALID_EXPOSURE"
      | "FINALIZE_REQUEST_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointExecuteRequestFinalizationError";
    this.code = code;
  }
}

export class CheckpointForwardFailureError extends Error {
  code:
    | "RESERVATION_NOT_FOUND"
    | "RESERVATION_NOT_IN_FORWARD"
    | "AGENTGATE_ACTION_ALREADY_ATTACHED"
    | "RESERVATION_ALREADY_FINALIZED"
    | "FORWARD_FAILURE_FAILED";

  constructor(
    code:
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_NOT_IN_FORWARD"
      | "AGENTGATE_ACTION_ALREADY_ATTACHED"
      | "RESERVATION_ALREADY_FINALIZED"
      | "FORWARD_FAILURE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CheckpointForwardFailureError";
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

    if (txParams.appendExecuteTransparencyRows) {
      appendTransparencyLogRow({
        delegationId: txParams.delegationId,
        eventType: "delegated_execute_requested",
        actorKind: "delegate",
      });
    }

    db.prepare(
      `INSERT INTO delegation_actions
       (id, delegation_id, forward_state, action_type, payload_json, declared_exposure_cents, effective_exposure_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reservationId,
      txParams.delegationId,
      CHECKPOINT_FORWARD_STATE_PENDING,
      txParams.actionType,
      JSON.stringify(txParams.payload),
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

    if (txParams.appendExecuteTransparencyRows) {
      appendTransparencyLogRow({
        delegationId: txParams.delegationId,
        reservationId,
        eventType: "checkpoint_action_reserved",
        actorKind: "checkpoint",
      });
    }

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

export function getCheckpointReservationExecutionStatus(
  reservationId: string
): CheckpointReservationExecutionStatus {
  const db = getDb();
  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(reservationId) as DelegationActionRow | undefined;

  if (!action) {
    return {
      status: "not_found",
      reservationId,
      forwardState: null,
      outcome: null,
      agentgateActionId: null,
      resolvedAt: null,
    };
  }

  let status: CheckpointReservationExecutionState;

  if (action.outcome === "success") {
    status = "finalized_success";
  } else if (
    action.outcome === "failed" &&
    action.forward_state === CHECKPOINT_FORWARD_STATE_IN_FORWARD &&
    action.agentgate_action_id === null
  ) {
    status = "pre_attachment_failed";
  } else if (action.outcome === "failed") {
    status = "finalized_failed";
  } else if (action.forward_state === CHECKPOINT_FORWARD_STATE_PENDING) {
    status = "pending_forward";
  } else if (action.forward_state === CHECKPOINT_FORWARD_STATE_IN_FORWARD) {
    status = "in_forward";
  } else {
    status = "forwarded";
  }

  return {
    status,
    reservationId: action.id,
    forwardState: action.forward_state,
    outcome: action.outcome,
    agentgateActionId: action.agentgate_action_id,
    resolvedAt: action.resolved_at,
  };
}

export function isCheckpointReservationExecuteEligible(
  reservationId: string
): CheckpointReservationExecuteEligibility {
  const status = getCheckpointReservationExecutionStatus(reservationId);

  if (
    status.status === "in_forward" &&
    status.agentgateActionId === null &&
    status.outcome === null
  ) {
    return {
      reservationId: status.reservationId,
      eligible: true,
      code: "ELIGIBLE",
    };
  }

  if (status.status === "not_found") {
    return {
      reservationId: status.reservationId,
      eligible: false,
      code: "NOT_FOUND",
    };
  }

  if (status.status === "pending_forward") {
    return {
      reservationId: status.reservationId,
      eligible: false,
      code: "NOT_IN_FORWARD",
    };
  }

  if (status.status === "forwarded") {
    return {
      reservationId: status.reservationId,
      eligible: false,
      code: "ALREADY_FORWARDED",
    };
  }

  if (
    status.status === "finalized_success" ||
    status.status === "finalized_failed"
  ) {
    return {
      reservationId: status.reservationId,
      eligible: false,
      code: "ALREADY_FINALIZED",
    };
  }

  return {
    reservationId: status.reservationId,
    eligible: false,
    code: "PRE_ATTACHMENT_FAILED",
  };
}

export function prepareCheckpointExecuteInput(
  reservationId: string
): CheckpointPreparedExecuteInput {
  const eligibility = isCheckpointReservationExecuteEligible(reservationId);

  if (!eligibility.eligible) {
    const messages: Record<
      Exclude<CheckpointReservationExecuteEligibilityCode, "ELIGIBLE">,
      string
    > = {
      NOT_FOUND: "Checkpoint reservation not found",
      NOT_IN_FORWARD: "Checkpoint reservation is not currently in_forward",
      ALREADY_FORWARDED:
        "Checkpoint reservation already has an attached AgentGate action id",
      ALREADY_FINALIZED: "Checkpoint reservation is already finalized",
      PRE_ATTACHMENT_FAILED:
        "Checkpoint reservation already failed before attachment",
    };

    throw new CheckpointExecutePreparationError(
      eligibility.code,
      messages[
        eligibility.code as Exclude<
          CheckpointReservationExecuteEligibilityCode,
          "ELIGIBLE"
        >
      ]
    );
  }

  const db = getDb();
  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(reservationId) as DelegationActionRow | undefined;

  if (!action) {
    throw new CheckpointExecutePreparationError(
      "PREPARE_INPUT_FAILED",
      "Execute-eligible checkpoint reservation disappeared before preparation"
    );
  }

  const delegation = getDelegation(action.delegation_id);
  if (!delegation) {
    throw new CheckpointExecutePreparationError(
      "DELEGATION_NOT_FOUND",
      "Delegation for checkpoint reservation not found"
    );
  }

  if (delegation.delegate_bond_id === null) {
    throw new CheckpointExecutePreparationError(
      "DELEGATE_BOND_NOT_FOUND",
      "Delegation has no recorded delegate bond id"
    );
  }

  if (action.payload_json === null) {
    throw new CheckpointExecutePreparationError(
      "PAYLOAD_NOT_RECORDED",
      "Checkpoint reservation has no recorded payload"
    );
  }

  try {
    return {
      reservationId: action.id,
      delegationId: action.delegation_id,
      delegateId: delegation.delegate_id,
      delegateBondId: delegation.delegate_bond_id,
      actionType: action.action_type,
      payload: JSON.parse(action.payload_json),
      declaredExposureCents: action.declared_exposure_cents,
      effectiveExposureCents: action.effective_exposure_cents,
    };
  } catch {
    throw new CheckpointExecutePreparationError(
      "PREPARE_INPUT_FAILED",
      "Checkpoint reservation payload could not be prepared"
    );
  }
}

export function buildCheckpointAgentGateExecuteRequest(
  preparedInput: CheckpointPreparedExecuteInput
): CheckpointAgentGateExecuteRequest {
  if (preparedInput.delegateId.trim().length === 0) {
    throw new CheckpointExecuteRequestBuildError(
      "MISSING_IDENTITY_REF",
      "Prepared execute input is missing delegate identity reference"
    );
  }

  if (preparedInput.delegateBondId.trim().length === 0) {
    throw new CheckpointExecuteRequestBuildError(
      "MISSING_BOND_ID",
      "Prepared execute input is missing delegate bond id"
    );
  }

  if (preparedInput.actionType.trim().length === 0) {
    throw new CheckpointExecuteRequestBuildError(
      "INVALID_ACTION_TYPE",
      "Prepared execute input is missing action type"
    );
  }

  if (
    !Number.isInteger(preparedInput.declaredExposureCents) ||
    preparedInput.declaredExposureCents <= 0
  ) {
    throw new CheckpointExecuteRequestBuildError(
      "INVALID_EXPOSURE",
      "Prepared execute input has an invalid declared exposure"
    );
  }

  try {
    return {
      identityRef: preparedInput.delegateId,
      bondId: preparedInput.delegateBondId,
      actionType: preparedInput.actionType,
      payload: preparedInput.payload,
      exposure_cents: preparedInput.declaredExposureCents,
    };
  } catch {
    throw new CheckpointExecuteRequestBuildError(
      "BUILD_REQUEST_FAILED",
      "Prepared execute input could not be converted into an AgentGate execute request"
    );
  }
}

export function resolveCheckpointAgentGateIdentityId(
  identityRef: string,
  identityFile?: string
): string {
  if (identityRef.trim().length === 0) {
    throw new CheckpointExecuteIdentityResolutionError(
      "MISSING_IDENTITY_REF",
      "Checkpoint execute identity reference is missing"
    );
  }

  try {
    const savedIdentity = agentGateClient.getSavedIdentityMetadata(identityFile);

    if (!savedIdentity) {
      throw new CheckpointExecuteIdentityResolutionError(
        "IDENTITY_FILE_NOT_FOUND",
        "No local AgentGate identity file was found for checkpoint execute identity resolution"
      );
    }

    if (savedIdentity.publicKey !== identityRef) {
      throw new CheckpointExecuteIdentityResolutionError(
        "IDENTITY_REF_MISMATCH",
        "Local AgentGate identity file does not match the checkpoint identity reference"
      );
    }

    if (
      typeof savedIdentity.identityId !== "string" ||
      savedIdentity.identityId.trim().length === 0
    ) {
      throw new CheckpointExecuteIdentityResolutionError(
        "IDENTITY_ID_NOT_FOUND",
        "Local AgentGate identity file does not contain a saved identityId"
      );
    }

    return savedIdentity.identityId;
  } catch (error) {
    if (error instanceof CheckpointExecuteIdentityResolutionError) {
      throw error;
    }

    throw new CheckpointExecuteIdentityResolutionError(
      "IDENTITY_RESOLUTION_FAILED",
      "Checkpoint execute identity boundary could not be resolved"
    );
  }
}

export function finalizeCheckpointAgentGateExecuteRequest(
  builtRequest: CheckpointAgentGateExecuteRequest,
  identityId: string
): CheckpointAgentGateExecuteRequestBody {
  if (identityId.trim().length === 0) {
    throw new CheckpointExecuteRequestFinalizationError(
      "MISSING_IDENTITY_ID",
      "Resolved AgentGate identityId is missing"
    );
  }

  if (builtRequest.identityRef.trim().length === 0) {
    throw new CheckpointExecuteRequestFinalizationError(
      "MISSING_IDENTITY_REF",
      "Built checkpoint execute request is missing identity reference"
    );
  }

  if (builtRequest.bondId.trim().length === 0) {
    throw new CheckpointExecuteRequestFinalizationError(
      "MISSING_BOND_ID",
      "Built checkpoint execute request is missing bond id"
    );
  }

  if (builtRequest.actionType.trim().length === 0) {
    throw new CheckpointExecuteRequestFinalizationError(
      "INVALID_ACTION_TYPE",
      "Built checkpoint execute request is missing action type"
    );
  }

  if (
    !Number.isInteger(builtRequest.exposure_cents) ||
    builtRequest.exposure_cents <= 0
  ) {
    throw new CheckpointExecuteRequestFinalizationError(
      "INVALID_EXPOSURE",
      "Built checkpoint execute request has an invalid exposure"
    );
  }

  try {
    return {
      identityId,
      bondId: builtRequest.bondId,
      actionType: builtRequest.actionType,
      payload: builtRequest.payload,
      exposure_cents: builtRequest.exposure_cents,
    };
  } catch {
    throw new CheckpointExecuteRequestFinalizationError(
      "FINALIZE_REQUEST_FAILED",
      "Built checkpoint execute request could not be finalized into an AgentGate execute body"
    );
  }
}

export function prepareFinalCheckpointAgentGateExecuteBody(
  reservationId: string,
  identityFile?: string
): CheckpointAgentGateExecuteRequestBody {
  const preparedInput = prepareCheckpointExecuteInput(reservationId);
  const builtRequest = buildCheckpointAgentGateExecuteRequest(preparedInput);
  const identityId = resolveCheckpointAgentGateIdentityId(
    builtRequest.identityRef,
    identityFile
  );

  return finalizeCheckpointAgentGateExecuteRequest(builtRequest, identityId);
}

export function getCheckpointExecuteReadiness(
  reservationId: string,
  identityFile?: string
): CheckpointExecuteReadiness {
  const eligibility = isCheckpointReservationExecuteEligible(reservationId);

  if (!eligibility.eligible) {
    return {
      ready: false,
      reservationId: eligibility.reservationId,
      code: eligibility.code,
    };
  }

  return {
    ready: true,
    reservationId: eligibility.reservationId,
    code: "READY",
    executeBody: prepareFinalCheckpointAgentGateExecuteBody(
      reservationId,
      identityFile
    ),
  };
}

export async function executeCheckpointForwardHandoff(
  reservationId: string,
  identityFile?: string
): Promise<CheckpointExecuteHandoffResult> {
  const readiness = getCheckpointExecuteReadiness(reservationId, identityFile);

  if (!readiness.ready || !readiness.executeBody) {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: readiness.reservationId,
      code: readiness.code as Exclude<
        CheckpointExecuteReadinessCode,
        "READY"
      >,
    };
  }

  const keys = agentGateClient.loadOrCreateKeypair(identityFile);

  try {
    const result = await agentGateClient.executeBondedAction(
      keys,
      readiness.executeBody.identityId,
      readiness.executeBody.bondId,
      readiness.executeBody.actionType,
      readiness.executeBody.payload,
      readiness.executeBody.exposure_cents
    );

    const agentgateActionId = result.actionId as string;
    attachCheckpointForwardedAction(reservationId, agentgateActionId);

    return {
      ok: true,
      stage: "forwarded",
      reservationId,
      agentgateActionId,
    };
  } catch (error) {
    failCheckpointForwardAttempt(reservationId);

    return {
      ok: false,
      stage: "pre_attachment_failed",
      reservationId,
      code: "AGENTGATE_EXECUTE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveCheckpointForwardedReservation(
  reservationId: string,
  outcome: CheckpointForwardFinalOutcome,
  identityFile?: string
): Promise<CheckpointForwardResolutionResult> {
  if (outcome !== "success" && outcome !== "failed") {
    throw new CheckpointForwardFinalizationError(
      "INVALID_FINAL_OUTCOME",
      `Unsupported checkpoint final outcome "${outcome}"`
    );
  }

  const status = getCheckpointReservationExecutionStatus(reservationId);

  if (status.status === "not_found") {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: status.reservationId,
      code: "NOT_FOUND",
    };
  }

  if (status.status === "pending_forward" || status.status === "in_forward") {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: status.reservationId,
      code: "NOT_FORWARDED",
    };
  }

  if (status.status === "pre_attachment_failed") {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: status.reservationId,
      code: "PRE_ATTACHMENT_FAILED",
    };
  }

  if (
    status.status === "finalized_success" ||
    status.status === "finalized_failed"
  ) {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: status.reservationId,
      code: "ALREADY_FINALIZED",
    };
  }

  if (status.agentgateActionId === null) {
    return {
      ok: false,
      stage: "not_ready",
      reservationId: status.reservationId,
      code: "AGENTGATE_ACTION_NOT_ATTACHED",
    };
  }

  const keys = agentGateClient.loadOrCreateKeypair(identityFile);
  const resolverId = await agentGateClient.createIdentity(keys, identityFile);

  try {
    await agentGateClient.resolveAgentGateAction(
      keys,
      resolverId,
      status.agentgateActionId,
      outcome
    );
  } catch (error) {
    return {
      ok: false,
      stage: "resolution_failed",
      reservationId: status.reservationId,
      agentgateActionId: status.agentgateActionId,
      code: "AGENTGATE_RESOLVE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  finalizeCheckpointForwardedAction(reservationId, outcome);

  return {
    ok: true,
    stage: "finalized",
    reservationId: status.reservationId,
    agentgateActionId: status.agentgateActionId,
    outcome,
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
    appendTransparencyLogRow({
      delegationId: action.delegation_id,
      reservationId: txReservationId,
      eventType: "checkpoint_forward_started",
      actorKind: "checkpoint",
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
      appendTransparencyLogRow({
        delegationId: action.delegation_id,
        reservationId: txReservationId,
        eventType: "checkpoint_forward_attached",
        actorKind: "checkpoint",
        agentgateActionId: txAgentgateActionId,
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

export function failCheckpointForwardAttempt(
  reservationId: string
): DelegationActionRow {
  const db = getDb();
  const failForwardAttempt = db.transaction((txReservationId: string) => {
    const action = db
      .prepare("SELECT * FROM delegation_actions WHERE id = ?")
      .get(txReservationId) as DelegationActionRow | undefined;

    if (!action) {
      throw new CheckpointForwardFailureError(
        "RESERVATION_NOT_FOUND",
        "Checkpoint reservation not found"
      );
    }

    if (action.outcome !== null || action.resolved_at !== null) {
      throw new CheckpointForwardFailureError(
        "RESERVATION_ALREADY_FINALIZED",
        "Checkpoint reservation is already finalized"
      );
    }

    if (action.agentgate_action_id !== null) {
      throw new CheckpointForwardFailureError(
        "AGENTGATE_ACTION_ALREADY_ATTACHED",
        "Checkpoint reservation already has an attached AgentGate action id"
      );
    }

    if (action.forward_state !== CHECKPOINT_FORWARD_STATE_IN_FORWARD) {
      throw new CheckpointForwardFailureError(
        "RESERVATION_NOT_IN_FORWARD",
        "Checkpoint reservation is not currently in_forward"
      );
    }

    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE delegation_actions
       SET outcome = ?, resolved_at = ?
       WHERE id = ? AND forward_state = ? AND agentgate_action_id IS NULL AND outcome IS NULL AND resolved_at IS NULL`
    ).run(
      "failed",
      now,
      txReservationId,
      CHECKPOINT_FORWARD_STATE_IN_FORWARD
    );

    if (result.changes !== 1) {
      throw new CheckpointForwardFailureError(
        "FORWARD_FAILURE_FAILED",
        "Failed to record pre-attachment checkpoint forward failure"
      );
    }

    logEvent(action.delegation_id, "checkpoint_forward_failed", {
      reservation_id: txReservationId,
      failure_reason: CHECKPOINT_FORWARD_FAILURE_REASON_PRE_ATTACHMENT,
    });
    appendTransparencyLogRow({
      delegationId: action.delegation_id,
      reservationId: txReservationId,
      eventType: "checkpoint_forward_failed",
      actorKind: "checkpoint",
      agentgateActionId: null,
      outcome: "failed",
      reasonCode: CHECKPOINT_FORWARD_FAILURE_REASON_PRE_ATTACHMENT,
    });

    return db
      .prepare("SELECT * FROM delegation_actions WHERE id = ?")
      .get(txReservationId) as DelegationActionRow;
  });

  try {
    return failForwardAttempt.immediate(reservationId);
  } catch (error) {
    if (error instanceof CheckpointForwardFailureError) {
      throw error;
    }

    throw new CheckpointForwardFailureError(
      "FORWARD_FAILURE_FAILED",
      "Failed to record pre-attachment checkpoint forward failure"
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
      appendTransparencyLogRow({
        delegationId: action.delegation_id,
        reservationId: txReservationId,
        eventType: "checkpoint_forward_finalized",
        actorKind: "resolver",
        agentgateActionId: action.agentgate_action_id,
        outcome: txOutcome,
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
    appendTransparencyLogRow({
      delegationId,
      eventType: "delegation_revoked",
      actorKind: "delegator",
    });
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
    appendTransparencyLogRow({
      delegationId,
      eventType: "delegation_revoked",
      actorKind: "delegator",
    });
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

  appendTransparencyLogRow({
    delegationId,
    eventType: "delegation_closed",
    actorKind: "delegator",
  });
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
