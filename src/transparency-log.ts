import { randomUUID } from "crypto";
import { getDb } from "./db";

const TRANSPARENCY_LOG_EVENT_TYPES = [
  "delegation_created",
  "delegation_accepted",
  "delegation_revoked",
  "delegation_closed",
  "delegated_execute_requested",
  "checkpoint_action_reserved",
  "checkpoint_forward_started",
  "checkpoint_forward_attached",
  "checkpoint_forward_finalized",
  "checkpoint_forward_failed",
] as const;

const TRANSPARENCY_LOG_ACTOR_KINDS = [
  "delegator",
  "delegate",
  "checkpoint",
  "resolver",
  "system",
] as const;

export type TransparencyLogEventType =
  typeof TRANSPARENCY_LOG_EVENT_TYPES[number];

export type TransparencyLogActorKind =
  typeof TRANSPARENCY_LOG_ACTOR_KINDS[number];

export interface TransparencyLogRow {
  id: string;
  delegation_id: string;
  reservation_id: string | null;
  event_type: TransparencyLogEventType;
  actor_kind: TransparencyLogActorKind;
  agentgate_action_id: string | null;
  outcome: string | null;
  reason_code: string | null;
  created_at: string;
}

export interface AppendTransparencyLogRowParams {
  delegationId: string;
  reservationId?: string | null;
  eventType: TransparencyLogEventType;
  actorKind: TransparencyLogActorKind;
  agentgateActionId?: string | null;
  outcome?: string | null;
  reasonCode?: string | null;
}

function isTransparencyLogEventType(
  value: string
): value is TransparencyLogEventType {
  return TRANSPARENCY_LOG_EVENT_TYPES.includes(
    value as TransparencyLogEventType
  );
}

function isTransparencyLogActorKind(
  value: string
): value is TransparencyLogActorKind {
  return TRANSPARENCY_LOG_ACTOR_KINDS.includes(
    value as TransparencyLogActorKind
  );
}

export function appendTransparencyLogRow(
  params: AppendTransparencyLogRowParams
): TransparencyLogRow {
  if (!isTransparencyLogEventType(params.eventType)) {
    throw new Error(
      `Unsupported transparency log event_type: ${params.eventType}`
    );
  }

  if (!isTransparencyLogActorKind(params.actorKind)) {
    throw new Error(
      `Unsupported transparency log actor_kind: ${params.actorKind}`
    );
  }

  const row: TransparencyLogRow = {
    id: randomUUID(),
    delegation_id: params.delegationId,
    reservation_id: params.reservationId ?? null,
    event_type: params.eventType,
    actor_kind: params.actorKind,
    agentgate_action_id: params.agentgateActionId ?? null,
    outcome: params.outcome ?? null,
    reason_code: params.reasonCode ?? null,
    created_at: new Date().toISOString(),
  };

  const db = getDb();
  db.prepare(
    `INSERT INTO delegation_transparency_log
     (id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.delegation_id,
    row.reservation_id,
    row.event_type,
    row.actor_kind,
    row.agentgate_action_id,
    row.outcome,
    row.reason_code,
    row.created_at
  );

  return row;
}
