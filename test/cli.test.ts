import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../src/db";

const TSX_PATH = path.join(process.cwd(), "node_modules", ".bin", "tsx");

let dbDir = "";
let dbPath = "";

function insertDelegation(delegationId: string): void {
  const now = "2026-04-20T12:00:00.000Z";
  const expiresAt = "2026-04-20T13:00:00.000Z";

  getDb()
    .prepare(
      `INSERT INTO delegations
       (id, delegator_id, delegate_id, scope_json, delegator_bond_id, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      delegationId,
      "delegator-pub-key",
      "delegate-pub-key",
      JSON.stringify({
        allowed_actions: ["email-rewrite"],
        max_actions: 3,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "Rewrite emails",
      }),
      "bond-123",
      "pending",
      now,
      expiresAt
    );
}

function insertTransparencyRow(params: {
  delegationId: string;
  createdAt: string;
  eventType:
    | "delegation_created"
    | "delegation_accepted"
    | "checkpoint_forward_failed";
  actorKind: "delegator" | "delegate" | "checkpoint";
  reservationId?: string;
  agentgateActionId?: string;
  outcome?: string;
  reasonCode?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO delegation_transparency_log
       (id, delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      params.delegationId,
      params.reservationId ?? null,
      params.eventType,
      params.actorKind,
      params.agentgateActionId ?? null,
      params.outcome ?? null,
      params.reasonCode ?? null,
      params.createdAt
    );
}

function runCli(args: string[]) {
  closeDb();
  return spawnSync(TSX_PATH, ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DELEGATION_DB_PATH: dbPath,
    },
    encoding: "utf8",
  });
}

beforeEach(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), "delegation-cli-"));
  dbPath = path.join(dbDir, "delegation.db");
  process.env.DELEGATION_DB_PATH = dbPath;
});

afterEach(() => {
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("cli status --log", () => {
  it("shows the transparency-log section for a delegation with rows", () => {
    const delegationId = randomUUID();
    insertDelegation(delegationId);
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:01:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });

    const result = runCli(["status", "--delegation", delegationId, "--log"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("=== Delegation Status ===");
    expect(result.stdout).toContain("=== Transparency Log (1) ===");
    expect(result.stdout).toContain(
      "2026-04-20T12:01:00.000Z | delegation_created | actor=delegator"
    );
  });

  it("renders transparency rows in chronological order", () => {
    const delegationId = randomUUID();
    insertDelegation(delegationId);
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:03:00.000Z",
      eventType: "checkpoint_forward_failed",
      actorKind: "checkpoint",
    });
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:01:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:02:00.000Z",
      eventType: "delegation_accepted",
      actorKind: "delegate",
    });

    const result = runCli(["status", "--delegation", delegationId, "--log"]);

    expect(result.status).toBe(0);
    expect(
      result.stdout.indexOf(
        "2026-04-20T12:01:00.000Z | delegation_created | actor=delegator"
      )
    ).toBeLessThan(
      result.stdout.indexOf(
        "2026-04-20T12:02:00.000Z | delegation_accepted | actor=delegate"
      )
    );
    expect(
      result.stdout.indexOf(
        "2026-04-20T12:02:00.000Z | delegation_accepted | actor=delegate"
      )
    ).toBeLessThan(
      result.stdout.indexOf(
        "2026-04-20T12:03:00.000Z | checkpoint_forward_failed | actor=checkpoint"
      )
    );
  });

  it("renders optional fields only when present", () => {
    const delegationId = randomUUID();
    insertDelegation(delegationId);
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:01:00.000Z",
      eventType: "delegation_created",
      actorKind: "delegator",
    });
    insertTransparencyRow({
      delegationId,
      createdAt: "2026-04-20T12:02:00.000Z",
      eventType: "checkpoint_forward_failed",
      actorKind: "checkpoint",
      reservationId: "reservation-123",
      agentgateActionId: "ag-action-123",
      outcome: "failed",
      reasonCode: "pre_attachment_forward_failed",
    });

    const result = runCli(["status", "--delegation", delegationId, "--log"]);
    const lines = result.stdout.split("\n");
    const createdLine = lines.find((line) => line.includes("delegation_created"));
    const failedLine = lines.find((line) =>
      line.includes("checkpoint_forward_failed")
    );

    expect(result.status).toBe(0);
    expect(createdLine).toBe(
      "  2026-04-20T12:01:00.000Z | delegation_created | actor=delegator"
    );
    expect(failedLine).toContain("reservation_id=reservation-123");
    expect(failedLine).toContain("agentgate_action_id=ag-action-123");
    expect(failedLine).toContain("outcome=failed");
    expect(failedLine).toContain(
      "reason_code=pre_attachment_forward_failed"
    );
  });

  it("handles an existing delegation with no transparency rows cleanly", () => {
    const delegationId = randomUUID();
    insertDelegation(delegationId);

    const result = runCli(["status", "--delegation", delegationId, "--log"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("=== Transparency Log (0) ===");
    expect(result.stdout).toContain("(no transparency log rows yet)");
  });

  it("preserves missing delegation behavior when --log is present", () => {
    const result = runCli(["status", "--delegation", randomUUID(), "--log"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Delegation not found.");
  });

  it("does not add a new top-level log command", () => {
    const result = runCli(["log"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "npx tsx src/cli.ts status    --delegation <id> [--log]"
    );
    expect(result.stdout).not.toContain("npx tsx src/cli.ts log");
  });
});
