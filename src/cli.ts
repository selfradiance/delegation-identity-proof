#!/usr/bin/env node
import "dotenv/config";
import { createHash } from "crypto";

import {
  getAgentBondTtlSeconds,
  getHumanBondTtlSeconds,
  MAX_DELEGATION_TTL_SECONDS,
} from "./bond-ttl";
import {
  loadOrCreateKeypair,
  createIdentity,
  postBond,
  executeBondedAction,
  resolveAgentGateAction,
  type AgentKeys,
} from "./agentgate-client";
import {
  createDelegation,
  getDelegation,
  claimForAccept,
  finalizeAccept,
  revertAccept,
  reserveAction,
  finalizeAction,
  revertAction,
  resolveAction as resolveLocalAction,
  revokeDelegation,
  closeDelegation,
  checkExpiry,
  recoverTransientStates,
  getActions,
  getEvents,
  type DelegationRow,
} from "./delegation";
import { DelegationScopeSchema, type DelegationScope } from "./scope";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

function getArg(name: string, required: true): string;
function getArg(name: string, required?: false): string | undefined;
function getArg(name: string, required = false): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    if (required) {
      console.error(`Missing required argument: --${name}`);
      process.exit(1);
    }
    return undefined;
  }
  return process.argv[idx + 1];
}

function getNumArg(name: string, required: true): number;
function getNumArg(name: string, required?: false): number | undefined;
function getNumArg(name: string, required = false): number | undefined {
  const val = getArg(name, required as true);
  if (val === undefined) return undefined;
  const n = Number(val);
  if (!Number.isFinite(n)) {
    console.error(`Invalid number for --${name}: ${val}`);
    process.exit(1);
  }
  return n;
}

function getPositiveIntArg(name: string, required: true): number;
function getPositiveIntArg(name: string, required?: false): number | undefined;
function getPositiveIntArg(
  name: string,
  required = false
): number | undefined {
  const n = getNumArg(name, required as true);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} must be a positive integer.`);
    process.exit(1);
  }
  return n;
}

function parsePayloadArg(payloadStr: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    console.error(`Invalid JSON in --payload: ${payloadStr}`);
    process.exit(1);
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    console.error("--payload must be a JSON object.");
    process.exit(1);
  }

  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

async function cmdDelegate(): Promise<void> {
  const to = getArg("to", true);
  const actionsStr = getArg("actions", true);
  const maxActions = getPositiveIntArg("max-actions", true);
  const maxExposure = getPositiveIntArg("max-exposure", true);
  const maxTotalExposure = getPositiveIntArg("max-total-exposure", true);
  const bondAmount = getPositiveIntArg("bond", true);
  const ttl = getPositiveIntArg("ttl", true);
  const description = getArg("description", true);
  const identityFile = getArg("identity-file");

  if (ttl > MAX_DELEGATION_TTL_SECONDS) {
    console.error(
      `TTL cannot exceed ${MAX_DELEGATION_TTL_SECONDS} seconds so the human bond can keep a 1-hour safety margin under AgentGate's 86400-second cap.`
    );
    process.exit(1);
  }

  const scope: DelegationScope = DelegationScopeSchema.parse({
    allowed_actions: actionsStr
      .split(",")
      .map((action) => action.trim())
      .filter((action) => action.length > 0),
    max_actions: maxActions,
    max_exposure_cents: maxExposure,
    max_total_exposure_cents: maxTotalExposure,
    description,
  });

  const keys = loadOrCreateKeypair(identityFile);
  const identityId = await createIdentity(keys, identityFile);

  console.log(`Human identity: ${identityId}`);
  console.log(`Human public key: ${keys.publicKey}`);

  // Lock human bond in AgentGate (commitment deposit, no action attached)
  const bondResult = await postBond(
    keys,
    identityId,
    bondAmount,
    getHumanBondTtlSeconds(ttl),
    "Delegation commitment deposit"
  );
  const bondId = bondResult.bondId as string;
  console.log(`Human bond locked: ${bondId}`);

  const delegation = createDelegation({
    delegatorId: keys.publicKey,
    delegateId: to,
    scope,
    delegatorBondId: bondId,
    ttlSeconds: ttl,
  });

  console.log(`\nDelegation created:`);
  console.log(`  ID: ${delegation.id}`);
  console.log(`  Status: ${delegation.status}`);
  console.log(`  Delegate: ${to}`);
  console.log(`  Expires: ${delegation.expires_at}`);
  console.log(`  Scope: ${description}`);
}

async function cmdAccept(): Promise<void> {
  const delegationId = getArg("delegation", true);
  const bondAmount = getPositiveIntArg("bond", true);
  const identityFile = getArg("identity-file");

  const keys = loadOrCreateKeypair(identityFile);

  // Phase 1: claim
  const claimed = claimForAccept(delegationId, keys.publicKey);
  if (!claimed) {
    console.error(
      "Failed to claim delegation. It may not exist, may target a different agent key, is not pending, or has expired."
    );
    process.exit(1);
  }

  // Phase 2: post bond to AgentGate
  let bondId: string;
  try {
    const identityId = await createIdentity(keys, identityFile);
    const bondTtlSeconds = getAgentBondTtlSeconds(claimed.expires_at);

    console.log(`Agent identity: ${identityId}`);
    console.log(`Agent public key: ${keys.publicKey}`);

    const bondResult = await postBond(
      keys,
      identityId,
      bondAmount,
      bondTtlSeconds,
      `Agent bond for delegation ${delegationId}`
    );
    bondId = bondResult.bondId as string;
  } catch (err) {
    // Phase 3: revert on failure
    revertAccept(delegationId);
    console.error(`Failed to register agent identity or post agent bond: ${err}`);
    process.exit(1);
  }

  // Phase 3: finalize
  const accepted = finalizeAccept(delegationId, bondId);
  if (!accepted) {
    console.error("Failed to finalize acceptance.");
    process.exit(1);
  }

  console.log(`\nDelegation accepted:`);
  console.log(`  ID: ${delegationId}`);
  console.log(`  Status: ${accepted.status}`);
  console.log(`  Agent bond: ${bondId}`);
}

async function cmdAct(): Promise<void> {
  const delegationId = getArg("delegation", true);
  const actionType = getArg("action-type", true);
  const exposure = getPositiveIntArg("exposure", true);
  const payloadStr = getArg("payload") ?? "{}";
  const identityFile = getArg("identity-file");
  const payload = parsePayloadArg(payloadStr);

  const keys = loadOrCreateKeypair(identityFile);

  // Phase 1: validate scope and reserve action slot
  const reservation = reserveAction({
    delegationId,
    actorPublicKey: keys.publicKey,
    actionType,
    declaredExposureCents: exposure,
  });

  if ("valid" in reservation && !reservation.valid) {
    console.error(`Action rejected: ${reservation.reason}`);
    process.exit(1);
  }

  if (!("actionId" in reservation)) {
    console.error("Unexpected error during action reservation.");
    process.exit(1);
  }

  const { actionId, delegation } = reservation;

  // Phase 2: execute in AgentGate
  let agentgateActionId: string;
  try {
    const identityId = await createIdentity(keys, identityFile);

    // Embed delegation metadata in action payload (convention per spec)
    payload.delegation_id = delegationId;
    payload.delegator_id = delegation.delegator_id;
    payload.scope_hash = createHash("sha256")
      .update(delegation.scope_json)
      .digest("hex")
      .slice(0, 16);

    const result = await executeBondedAction(
      keys,
      identityId,
      delegation.delegate_bond_id!,
      actionType,
      payload,
      exposure
    );
    agentgateActionId = result.actionId as string;
  } catch (err) {
    // Phase 3: revert on failure
    revertAction(actionId);

    // Check for rate limiting — action not counted against delegation limits
    if (err instanceof Error && err.message.includes("(429)")) {
      const { getDb } = await import("./db");
      const db = getDb();
      const { randomUUID } = await import("crypto");
      db.prepare(
        `INSERT INTO delegation_events (id, delegation_id, event_type, detail_json, created_at)
         VALUES (?, ?, 'action_rejected_rate_limited', ?, ?)`
      ).run(
        randomUUID(),
        delegationId,
        JSON.stringify({ action_type: actionType, declared_exposure_cents: exposure }),
        new Date().toISOString()
      );
      console.error("Rate limited by AgentGate. Action not counted against delegation limits.");
      process.exit(1);
    }

    console.error(`Failed to register agent identity or execute action: ${err}`);
    process.exit(1);
  }

  // Phase 3: finalize
  finalizeAction(actionId, delegationId, agentgateActionId);

  console.log(`\nAction executed:`);
  console.log(`  Local action ID: ${actionId}`);
  console.log(`  AgentGate action ID: ${agentgateActionId}`);
  console.log(`  Type: ${actionType}`);
  console.log(`  Declared exposure: ${exposure}¢`);
}

async function cmdResolve(): Promise<void> {
  const actionId = getArg("action", true);
  const outcome = getArg("outcome", true);
  const identityFile = getArg("identity-file");

  if (outcome !== "success" && outcome !== "failed" && outcome !== "malicious") {
    console.error('Outcome must be "success", "failed", or "malicious"');
    process.exit(1);
  }

  // Find the action in local DB
  const { getDb } = await import("./db");
  const db = getDb();
  const action = db
    .prepare("SELECT * FROM delegation_actions WHERE id = ?")
    .get(actionId) as
    | {
        agentgate_action_id: string;
        delegation_id: string;
        outcome: string | null;
      }
    | undefined;

  if (!action || !action.agentgate_action_id) {
    console.error("Action not found or not yet finalized.");
    process.exit(1);
  }

  if (action.outcome !== null) {
    console.error("Action is already resolved locally.");
    process.exit(1);
  }

  const keys = loadOrCreateKeypair(identityFile);
  const resolverId = await createIdentity(keys, identityFile);

  // Resolve in AgentGate
  await resolveAgentGateAction(
    keys,
    resolverId,
    action.agentgate_action_id,
    outcome as "success" | "failed" | "malicious"
  );

  const localOutcome = outcome as "success" | "failed" | "malicious";
  const resolved = resolveLocalAction(actionId, localOutcome);

  if (!resolved) {
    console.error("Failed to resolve action locally (may already be resolved).");
    process.exit(1);
  }

  const delegation = getDelegation(action.delegation_id);
  console.log(`\nAction resolved:`);
  console.log(`  Action ID: ${actionId}`);
  console.log(`  Outcome: ${outcome}`);
  console.log(`  Delegation status: ${delegation?.status}`);
}

function cmdRevoke(): void {
  const delegationId = getArg("delegation", true);

  const result = revokeDelegation(delegationId);
  if (!result) {
    console.error(
      "Failed to revoke. Delegation may not exist or is already in a terminal state."
    );
    process.exit(1);
  }

  console.log(`\nDelegation revoked:`);
  console.log(`  ID: ${delegationId}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Terminal reason: ${result.terminal_reason}`);
  if (result.status === "settling") {
    console.log("  Note: Open actions still settling. No new actions allowed.");
  }
}

function cmdClose(): void {
  const delegationId = getArg("delegation", true);

  const result = closeDelegation(delegationId);
  if (!result) {
    console.error(
      "Failed to close. Delegation must be active with all actions resolved."
    );
    process.exit(1);
  }

  console.log(`\nDelegation closed:`);
  console.log(`  ID: ${delegationId}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Outcome: ${result.delegation_outcome}`);
}

function cmdStatus(): void {
  const delegationId = getArg("delegation", true);

  // Check expiry first
  checkExpiry(delegationId);

  const delegation = getDelegation(delegationId);
  if (!delegation) {
    console.error("Delegation not found.");
    process.exit(1);
  }

  const scope: DelegationScope = JSON.parse(delegation.scope_json);
  const actions = getActions(delegationId);
  const events = getEvents(delegationId);

  console.log("=== Delegation Status ===");
  console.log(`  ID:              ${delegation.id}`);
  console.log(`  Status:          ${delegation.status}`);
  console.log(`  Terminal reason: ${delegation.terminal_reason ?? "(none)"}`);
  console.log(`  Outcome:         ${delegation.delegation_outcome ?? "(pending)"}`);
  console.log(`  Delegator:       ${delegation.delegator_id}`);
  console.log(`  Delegate:        ${delegation.delegate_id}`);
  console.log(`  Created:         ${delegation.created_at}`);
  console.log(`  Accepted:        ${delegation.accepted_at ?? "(not yet)"}`);
  console.log(`  Expires:         ${delegation.expires_at}`);
  console.log(`  Completed:       ${delegation.completed_at ?? "(not yet)"}`);
  console.log(`  Human bond:      ${delegation.delegator_bond_id}`);
  console.log(`  Agent bond:      ${delegation.delegate_bond_id ?? "(none)"}`);

  console.log("\n=== Scope ===");
  console.log(`  Allowed actions: ${scope.allowed_actions.join(", ")}`);
  console.log(`  Max actions:     ${scope.max_actions}`);
  console.log(`  Max exposure:    ${scope.max_exposure_cents}¢`);
  console.log(`  Max total:       ${scope.max_total_exposure_cents}¢`);
  console.log(`  Description:     ${scope.description}`);

  console.log(`\n=== Actions (${actions.length}) ===`);
  for (const action of actions) {
    console.log(
      `  [${action.outcome ?? "open"}] ${action.action_type} — ${action.declared_exposure_cents}¢ (eff: ${action.effective_exposure_cents}¢) — ${action.id}`
    );
  }

  console.log(`\n=== Event Trail (${events.length}) ===`);
  for (const event of events) {
    const detail = event.detail_json
      ? ` — ${event.detail_json}`
      : "";
    console.log(`  ${event.created_at} ${event.event_type}${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Recover any transient states from a prior crash
  recoverTransientStates();

  const command = process.argv[2];

  switch (command) {
    case "delegate":
      await cmdDelegate();
      break;
    case "accept":
      await cmdAccept();
      break;
    case "act":
      await cmdAct();
      break;
    case "resolve":
      await cmdResolve();
      break;
    case "revoke":
      cmdRevoke();
      break;
    case "close":
      cmdClose();
      break;
    case "status":
      cmdStatus();
      break;
    default:
      console.log(`Delegation Identity Proof — CLI

Usage:
  npx tsx src/cli.ts delegate  --to <agent-pub-key> --actions <types> --max-actions <n> --max-exposure <cents> --max-total-exposure <cents> --bond <cents> --ttl <seconds> --description <text>
  npx tsx src/cli.ts accept    --delegation <id> --bond <cents> [--identity-file <path>]
  npx tsx src/cli.ts act       --delegation <id> --action-type <type> --exposure <cents> [--payload <json>] [--identity-file <path>]
  npx tsx src/cli.ts resolve   --action <id> --outcome <success|failed|malicious> [--identity-file <path>]
  npx tsx src/cli.ts revoke    --delegation <id>
  npx tsx src/cli.ts close     --delegation <id>
  npx tsx src/cli.ts status    --delegation <id>
`);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
