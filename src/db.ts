import Database from "better-sqlite3";
import path from "path";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dbPath = process.env.DELEGATION_DB_PATH ?? path.resolve("delegation.db");
    _db = new Database(dbPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegations (
      id                        TEXT PRIMARY KEY,
      delegator_id              TEXT NOT NULL,
      delegate_id               TEXT NOT NULL,
      scope_json                TEXT NOT NULL,
      delegator_bond_id         TEXT NOT NULL,
      delegate_bond_id          TEXT,
      delegator_bond_outcome    TEXT,
      delegator_bond_resolved_at TEXT,
      delegation_outcome        TEXT,
      status                    TEXT NOT NULL DEFAULT 'pending',
      terminal_reason           TEXT,
      created_at                TEXT NOT NULL,
      accepted_at               TEXT,
      expires_at                TEXT NOT NULL,
      completed_at              TEXT
    );

    CREATE TABLE IF NOT EXISTS delegation_actions (
      id                        TEXT PRIMARY KEY,
      delegation_id             TEXT NOT NULL,
      agentgate_action_id       TEXT,
      forward_state             TEXT,
      action_type               TEXT NOT NULL,
      payload_json              TEXT,
      declared_exposure_cents    INTEGER NOT NULL,
      effective_exposure_cents   INTEGER NOT NULL,
      outcome                   TEXT,
      created_at                TEXT NOT NULL,
      resolved_at               TEXT,
      FOREIGN KEY (delegation_id) REFERENCES delegations(id)
    );

    CREATE TABLE IF NOT EXISTS delegation_events (
      id                        TEXT PRIMARY KEY,
      delegation_id             TEXT NOT NULL,
      event_type                TEXT NOT NULL,
      detail_json               TEXT,
      created_at                TEXT NOT NULL,
      FOREIGN KEY (delegation_id) REFERENCES delegations(id)
    );

    CREATE TABLE IF NOT EXISTS delegation_transparency_log (
      id                        TEXT PRIMARY KEY,
      delegation_id             TEXT NOT NULL,
      reservation_id            TEXT,
      event_type                TEXT NOT NULL CHECK (
        event_type IN (
          'delegation_created',
          'delegation_accepted',
          'delegation_revoked',
          'delegation_closed',
          'delegated_execute_requested',
          'checkpoint_scope_rejected',
          'checkpoint_action_reserved',
          'checkpoint_forward_started',
          'checkpoint_forward_attached',
          'checkpoint_forward_finalized',
          'checkpoint_forward_failed'
        )
      ),
      actor_kind                TEXT NOT NULL CHECK (
        actor_kind IN ('delegator', 'delegate', 'checkpoint', 'resolver', 'system')
      ),
      agentgate_action_id       TEXT,
      outcome                   TEXT,
      reason_code               TEXT,
      created_at                TEXT NOT NULL,
      prev_hash                 TEXT,
      entry_hash                TEXT,
      hash_version              INTEGER,
      FOREIGN KEY (delegation_id) REFERENCES delegations(id)
    );
  `);

  ensureColumn(db, "delegation_actions", "forward_state", "TEXT");
  ensureColumn(db, "delegation_actions", "payload_json", "TEXT");
  ensureColumn(db, "delegation_transparency_log", "prev_hash", "TEXT");
  ensureColumn(db, "delegation_transparency_log", "entry_hash", "TEXT");
  ensureColumn(db, "delegation_transparency_log", "hash_version", "INTEGER");
  ensureTransparencyLogSupportsScopeRejected(db);
}

function ensureTransparencyLogSupportsScopeRejected(db: Database.Database): void {
  const table = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'delegation_transparency_log'`
    )
    .get() as { sql: string } | undefined;

  if (!table || table.sql.includes("'checkpoint_scope_rejected'")) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;

    ALTER TABLE delegation_transparency_log
      RENAME TO delegation_transparency_log_old;

    CREATE TABLE delegation_transparency_log (
      id                        TEXT PRIMARY KEY,
      delegation_id             TEXT NOT NULL,
      reservation_id            TEXT,
      event_type                TEXT NOT NULL CHECK (
        event_type IN (
          'delegation_created',
          'delegation_accepted',
          'delegation_revoked',
          'delegation_closed',
          'delegated_execute_requested',
          'checkpoint_scope_rejected',
          'checkpoint_action_reserved',
          'checkpoint_forward_started',
          'checkpoint_forward_attached',
          'checkpoint_forward_finalized',
          'checkpoint_forward_failed'
        )
      ),
      actor_kind                TEXT NOT NULL CHECK (
        actor_kind IN ('delegator', 'delegate', 'checkpoint', 'resolver', 'system')
      ),
      agentgate_action_id       TEXT,
      outcome                   TEXT,
      reason_code               TEXT,
      created_at                TEXT NOT NULL,
      prev_hash                 TEXT,
      entry_hash                TEXT,
      hash_version              INTEGER,
      FOREIGN KEY (delegation_id) REFERENCES delegations(id)
    );

    INSERT INTO delegation_transparency_log (
      rowid,
      id,
      delegation_id,
      reservation_id,
      event_type,
      actor_kind,
      agentgate_action_id,
      outcome,
      reason_code,
      created_at,
      prev_hash,
      entry_hash,
      hash_version
    )
    SELECT
      rowid,
      id,
      delegation_id,
      reservation_id,
      event_type,
      actor_kind,
      agentgate_action_id,
      outcome,
      reason_code,
      created_at,
      prev_hash,
      entry_hash,
      hash_version
    FROM delegation_transparency_log_old
    ORDER BY rowid;

    DROP TABLE delegation_transparency_log_old;

    PRAGMA foreign_keys = ON;
  `);
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  columnDefinition: string
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as { name: string }[];

  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`
  );
}
