import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  TRANSPARENCY_LOG_HASH_VERSION_1,
  type TransparencyLogHashableRowV1,
} from "./transparency-log-canonical";
import { computeTransparencyLogEntryHashV1 } from "./transparency-log-hash";

const TRANSPARENCY_LOG_EVENT_TYPES = [
  "delegation_created",
  "delegation_accepted",
  "delegation_revoked",
  "delegation_closed",
  "delegated_execute_requested",
  "checkpoint_scope_rejected",
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
  prev_hash: string | null;
  entry_hash: string | null;
  hash_version: number | null;
}

interface StoredTransparencyLogRow extends TransparencyLogRow {
  sqlite_rowid: number;
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

export type TransparencyLogVerificationReasonCode =
  | "PARTIAL_CHAIN_FIELDS"
  | "UNSUPPORTED_HASH_VERSION"
  | "UNEXPECTED_PREV_HASH_ON_CHAIN_START"
  | "PREV_HASH_MISMATCH"
  | "ENTRY_HASH_MISMATCH"
  | "LEGACY_ROW_AFTER_CHAIN_STARTED"
  | "CHAIN_ROWID_GAP";

interface TransparencyLogVerificationBase {
  chainedRows: number;
  legacyUnchainedRows: number;
}

export interface TransparencyLogVerificationOk
  extends TransparencyLogVerificationBase {
  status: "ok";
}

export interface TransparencyLogVerificationBroken
  extends TransparencyLogVerificationBase {
  status: "broken";
  brokenRowId: string;
  brokenRowSqliteRowid: number;
  brokenDelegationId: string;
  reasonCode: TransparencyLogVerificationReasonCode;
  reason: string;
}

export type TransparencyLogVerificationResult =
  | TransparencyLogVerificationOk
  | TransparencyLogVerificationBroken;

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

function isLegacyUnchainedRow(row: TransparencyLogRow): boolean {
  return (
    row.prev_hash === null &&
    row.entry_hash === null &&
    row.hash_version === null
  );
}

function hasCompleteHashFields(row: TransparencyLogRow): boolean {
  return (
    row.hash_version !== null &&
    typeof row.entry_hash === "string" &&
    (row.prev_hash === null || typeof row.prev_hash === "string")
  );
}

function toHashableRowV1(
  row: Pick<
    TransparencyLogRow,
    | "id"
    | "delegation_id"
    | "reservation_id"
    | "event_type"
    | "actor_kind"
    | "agentgate_action_id"
    | "outcome"
    | "reason_code"
    | "created_at"
    | "hash_version"
  >
): TransparencyLogHashableRowV1 {
  return {
    id: row.id,
    delegation_id: row.delegation_id,
    reservation_id: row.reservation_id,
    event_type: row.event_type,
    actor_kind: row.actor_kind,
    agentgate_action_id: row.agentgate_action_id,
    outcome: row.outcome,
    reason_code: row.reason_code,
    created_at: row.created_at,
    hash_version: TRANSPARENCY_LOG_HASH_VERSION_1,
  };
}

function getLatestTransparencyLogHash():
  | { entry_hash: string | null }
  | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT entry_hash
       FROM delegation_transparency_log
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get() as { entry_hash: string | null } | undefined;
}

function buildBrokenResult(
  row: StoredTransparencyLogRow,
  reasonCode: TransparencyLogVerificationReasonCode,
  chainedRows: number,
  legacyUnchainedRows: number
): TransparencyLogVerificationBroken {
  const reasons: Record<TransparencyLogVerificationReasonCode, string> = {
    PARTIAL_CHAIN_FIELDS:
      "row has partial chain fields; legacy rows must stay fully unchained",
    UNSUPPORTED_HASH_VERSION:
      "row uses an unsupported transparency-log hash version",
    UNEXPECTED_PREV_HASH_ON_CHAIN_START:
      "first chained row must start with prev_hash = null",
    PREV_HASH_MISMATCH:
      "row prev_hash does not match the previous chained row entry_hash",
    ENTRY_HASH_MISMATCH:
      "row entry_hash does not match the recomputed hash for this row",
    LEGACY_ROW_AFTER_CHAIN_STARTED:
      "legacy unchained rows are only allowed before the first chained row",
    CHAIN_ROWID_GAP:
      "rowid gap detected inside the chained segment",
  };

  return {
    status: "broken",
    brokenRowId: row.id,
    brokenRowSqliteRowid: row.sqlite_rowid,
    brokenDelegationId: row.delegation_id,
    reasonCode,
    reason: reasons[reasonCode],
    chainedRows,
    legacyUnchainedRows,
  };
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

  const db = getDb();
  const appendRow = db.transaction(
    (txParams: AppendTransparencyLogRowParams): TransparencyLogRow => {
      const previousRow = getLatestTransparencyLogHash();
      const prevHash = previousRow?.entry_hash ?? null;
      const hashVersion = TRANSPARENCY_LOG_HASH_VERSION_1;

      const rowWithoutHashes = {
        id: randomUUID(),
        delegation_id: txParams.delegationId,
        reservation_id: txParams.reservationId ?? null,
        event_type: txParams.eventType,
        actor_kind: txParams.actorKind,
        agentgate_action_id: txParams.agentgateActionId ?? null,
        outcome: txParams.outcome ?? null,
        reason_code: txParams.reasonCode ?? null,
        created_at: new Date().toISOString(),
        hash_version: hashVersion,
      } satisfies TransparencyLogHashableRowV1;

      const entryHash = computeTransparencyLogEntryHashV1(
        rowWithoutHashes,
        prevHash
      );

      const row: TransparencyLogRow = {
        ...rowWithoutHashes,
        prev_hash: prevHash,
        entry_hash: entryHash,
      };

      db.prepare(
        `INSERT INTO delegation_transparency_log
         (id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at, prev_hash, entry_hash, hash_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.delegation_id,
        row.reservation_id,
        row.event_type,
        row.actor_kind,
        row.agentgate_action_id,
        row.outcome,
        row.reason_code,
        row.created_at,
        row.prev_hash,
        row.entry_hash,
        row.hash_version
      );

      return row;
    }
  );

  return appendRow.immediate(params);
}

export function getTransparencyLogRows(
  delegationId: string
): TransparencyLogRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at, prev_hash, entry_hash, hash_version
       FROM delegation_transparency_log
       WHERE delegation_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(delegationId) as TransparencyLogRow[];
}

export function verifyTransparencyLog(): TransparencyLogVerificationResult {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rowid AS sqlite_rowid, id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at, prev_hash, entry_hash, hash_version
       FROM delegation_transparency_log
       ORDER BY rowid ASC`
    )
    .all() as StoredTransparencyLogRow[];

  let legacyUnchainedRows = 0;
  let chainedRows = 0;
  let previousChainedRow: StoredTransparencyLogRow | null = null;

  for (const row of rows) {
    if (isLegacyUnchainedRow(row)) {
      if (previousChainedRow) {
        return buildBrokenResult(
          row,
          "LEGACY_ROW_AFTER_CHAIN_STARTED",
          chainedRows,
          legacyUnchainedRows
        );
      }

      legacyUnchainedRows += 1;
      continue;
    }

    if (!hasCompleteHashFields(row)) {
      return buildBrokenResult(
        row,
        "PARTIAL_CHAIN_FIELDS",
        chainedRows,
        legacyUnchainedRows
      );
    }

    if (row.hash_version !== TRANSPARENCY_LOG_HASH_VERSION_1) {
      return buildBrokenResult(
        row,
        "UNSUPPORTED_HASH_VERSION",
        chainedRows,
        legacyUnchainedRows
      );
    }

    const expectedPrevHash = previousChainedRow?.entry_hash ?? null;
    if (expectedPrevHash === null && row.prev_hash !== null) {
      return buildBrokenResult(
        row,
        "UNEXPECTED_PREV_HASH_ON_CHAIN_START",
        chainedRows,
        legacyUnchainedRows
      );
    }

    if (previousChainedRow) {
      if (row.sqlite_rowid !== previousChainedRow.sqlite_rowid + 1) {
        return buildBrokenResult(
          row,
          "CHAIN_ROWID_GAP",
          chainedRows,
          legacyUnchainedRows
        );
      }

      if (row.prev_hash !== previousChainedRow.entry_hash) {
        return buildBrokenResult(
          row,
          "PREV_HASH_MISMATCH",
          chainedRows,
          legacyUnchainedRows
        );
      }
    }

    const expectedEntryHash = computeTransparencyLogEntryHashV1(
      toHashableRowV1(row),
      expectedPrevHash
    );

    if (row.entry_hash !== expectedEntryHash) {
      return buildBrokenResult(
        row,
        "ENTRY_HASH_MISMATCH",
        chainedRows,
        legacyUnchainedRows
      );
    }

    previousChainedRow = row;
    chainedRows += 1;
  }

  return {
    status: "ok",
    chainedRows,
    legacyUnchainedRows,
  };
}
