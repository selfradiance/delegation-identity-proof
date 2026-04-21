import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import * as agentGateClient from "../src/agentgate-client";
import { createCheckpointServer } from "../src/checkpoint-server";
import { closeDb, getDb } from "../src/db";
import {
  attachCheckpointForwardedAction,
  CHECKPOINT_FORWARD_STATE_FORWARDED,
  CHECKPOINT_FORWARD_STATE_IN_FORWARD,
  claimForAccept,
  createDelegation,
  finalizeAccept,
  finalizeCheckpointForwardedAction,
  getActions,
  getDelegation,
  getCheckpointReservationForwardStatus,
  getEvents,
  reserveCheckpointAction,
  startCheckpointForwardAttempt,
  type DelegationRow,
} from "../src/delegation";
import {
  signCheckpointRequest,
  type CheckpointSignerKeys,
} from "../src/checkpoint-auth";

const VALID_DELEGATION_ID = "11111111-1111-4111-8111-111111111111";
const VALID_REQUEST_TEMPLATE = {
  actionType: "email-rewrite",
  payload: {
    input: "Please rewrite this email",
  },
  declaredExposureCents: 83,
};

const serversToClose = new Set<Server>();
const TEST_CHECKPOINT_AGENT_IDENTITY_FILE =
  "test-checkpoint-agent-execute-identity.json";
const TEST_CHECKPOINT_RESOLVER_IDENTITY_FILE =
  "test-checkpoint-resolver-identity.json";

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

function generateTestKeys(): CheckpointSignerKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const privateJwk = privateKey.export({ format: "jwk" }) as { d?: string };

  if (!publicJwk.x || !privateJwk.d) {
    throw new Error("Failed to generate Ed25519 test keys");
  }

  return {
    publicKey: base64UrlToBase64(publicJwk.x),
    privateKey: base64UrlToBase64(privateJwk.d),
  };
}

function createAcceptedDelegation(delegateKeys: CheckpointSignerKeys): DelegationRow {
  return createAcceptedDelegationWithScope(delegateKeys, {
    allowed_actions: ["email-rewrite"],
    max_actions: 3,
    max_exposure_cents: 83,
    max_total_exposure_cents: 250,
    description: "Rewrite emails",
  });
}

function createAcceptedDelegationWithScope(
  delegateKeys: CheckpointSignerKeys,
  scope: {
    allowed_actions: string[];
    max_actions: number;
    max_exposure_cents: number;
    max_total_exposure_cents: number;
    description: string;
  }
): DelegationRow {
  const delegation = createDelegation({
    delegatorId: "human-pub-key",
    delegateId: delegateKeys.publicKey,
    scope,
    delegatorBondId: "human-bond-123",
    ttlSeconds: 3600,
  });

  claimForAccept(delegation.id, delegateKeys.publicKey);
  finalizeAccept(delegation.id, "agent-bond-123");
  fs.writeFileSync(
    TEST_CHECKPOINT_AGENT_IDENTITY_FILE,
    JSON.stringify({
      publicKey: delegateKeys.publicKey,
      privateKey: delegateKeys.privateKey,
      identityId: "agentgate-identity-123",
    })
  );
  process.env.AGENT_IDENTITY_FILE = TEST_CHECKPOINT_AGENT_IDENTITY_FILE;
  return delegation;
}

function buildSignedRequest(
  delegationId: string,
  signerKeys: CheckpointSignerKeys,
  overrides?: Partial<{
    delegateId: string;
    timestamp: string;
    actionType: string;
    declaredExposureCents: number;
    payload: unknown;
  }>
) {
  const delegateId = overrides?.delegateId ?? signerKeys.publicKey;
  const timestamp = overrides?.timestamp ?? new Date().toISOString();
  const actionType = overrides?.actionType ?? VALID_REQUEST_TEMPLATE.actionType;
  const declaredExposureCents =
    overrides?.declaredExposureCents ?? VALID_REQUEST_TEMPLATE.declaredExposureCents;
  const payload = overrides?.payload ?? VALID_REQUEST_TEMPLATE.payload;

  const signature = signCheckpointRequest(
    {
      delegationId,
      delegateId,
      actionType,
      declaredExposureCents,
      payload,
      timestamp,
    },
    signerKeys
  );

  return {
    actionType,
    payload,
    declaredExposureCents,
    auth: {
      delegateId,
      timestamp,
      signature,
    },
  };
}

beforeEach(() => {
  process.env.DELEGATION_DB_PATH = ":memory:";
  vi.spyOn(agentGateClient, "executeBondedAction").mockResolvedValue({
    actionId: "ag-checkpoint-001",
  });
});

afterEach(async () => {
  await Promise.all(
    Array.from(serversToClose, (server) =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      })
    )
  );
  serversToClose.clear();
  closeDb();
  delete process.env.DELEGATION_DB_PATH;
  delete process.env.AGENT_IDENTITY_FILE;
  delete process.env.CHECKPOINT_RESOLVER_IDENTITY_FILE;
  if (fs.existsSync(TEST_CHECKPOINT_AGENT_IDENTITY_FILE)) {
    fs.unlinkSync(TEST_CHECKPOINT_AGENT_IDENTITY_FILE);
  }
  if (fs.existsSync(TEST_CHECKPOINT_RESOLVER_IDENTITY_FILE)) {
    fs.unlinkSync(TEST_CHECKPOINT_RESOLVER_IDENTITY_FILE);
  }
  vi.restoreAllMocks();
});

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createCheckpointServer();
  serversToClose.add(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function getCheckpointReservedEvents(delegationId: string) {
  return getEvents(delegationId).filter(
    (event) => event.event_type === "checkpoint_action_reserved"
  );
}

function getCheckpointTransparencyRows(delegationId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT delegation_id, reservation_id, event_type, actor_kind, agentgate_action_id, outcome, reason_code
       FROM delegation_transparency_log
       WHERE delegation_id = ?
         AND event_type IN (
           'delegated_execute_requested',
           'checkpoint_action_reserved',
           'checkpoint_forward_started',
           'checkpoint_forward_attached',
           'checkpoint_forward_finalized',
           'checkpoint_forward_failed'
         )
       ORDER BY rowid`
    )
    .all(delegationId) as Array<Record<string, unknown>>;
}

function writeResolverIdentityFile(identityId = "resolver-identity-123") {
  fs.writeFileSync(
    TEST_CHECKPOINT_RESOLVER_IDENTITY_FILE,
    JSON.stringify({
      publicKey: "resolver-pub-key",
      privateKey: Buffer.alloc(32, 2).toString("base64"),
      identityId,
    })
  );
  process.env.CHECKPOINT_RESOLVER_IDENTITY_FILE =
    TEST_CHECKPOINT_RESOLVER_IDENTITY_FILE;
}

describe("checkpoint server — execute endpoint", () => {
  it('executes an in-scope delegated action through the checkpoint and returns stage "forwarded"', async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      stage: "forwarded",
      forwardState: "forwarded",
      delegationId: delegation.id,
      actionType: "email-rewrite",
      reservationId: expect.any(String),
      agentgateActionId: "ag-checkpoint-001",
    });

    const actions = getActions(delegation.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(body.reservationId);
    expect(actions[0].delegation_id).toBe(delegation.id);
    expect(actions[0].forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(actions[0].action_type).toBe("email-rewrite");
    expect(actions[0].payload_json).toBe(
      JSON.stringify(VALID_REQUEST_TEMPLATE.payload)
    );
    expect(actions[0].declared_exposure_cents).toBe(83);
    expect(actions[0].effective_exposure_cents).toBe(100);
    expect(actions[0].agentgate_action_id).toBe("ag-checkpoint-001");
    expect(actions[0].outcome).toBeNull();
    expect(agentGateClient.executeBondedAction).toHaveBeenCalledTimes(1);
  });

  it("associates the reservation with the correct delegation and delegate event trail", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite", "file-transform"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "Rewrite or transform",
    });
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys, {
      actionType: "file-transform",
      declaredExposureCents: 10,
      payload: { file: "draft.txt" },
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const actions = getActions(delegation.id);
    const reserveEvents = getEvents(delegation.id).filter(
      (event) => event.event_type === "checkpoint_action_reserved"
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(body.reservationId);
    expect(actions[0].delegation_id).toBe(delegation.id);
    expect(reserveEvents).toHaveLength(1);
    expect(JSON.parse(reserveEvents[0].detail_json ?? "{}")).toMatchObject({
      reservation_id: body.reservationId,
      forward_state: "pending_forward",
      delegate_id: delegateKeys.publicKey,
      action_type: "file-transform",
      declared_exposure_cents: 10,
      effective_exposure_cents: 12,
    });
    expect(actions[0].forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(actions[0].agentgate_action_id).toBe("ag-checkpoint-001");
  });

  it("response clearly indicates the reservation has been forwarded", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stage: "forwarded",
      forwardState: "forwarded",
      agentgateActionId: "ag-checkpoint-001",
    });
  });

  it("reservation forward-status helper reports the reservation is no longer forward-eligible", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    const body = await response.json();
    const status = getCheckpointReservationForwardStatus(body.reservationId);

    expect(status).not.toBeNull();
    expect(status!.eligible).toBe(false);
    expect(status!.action.id).toBe(body.reservationId);
    expect(status!.action.forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(status!.action.agentgate_action_id).toBe("ag-checkpoint-001");
    expect(status!.action.outcome).toBeNull();
  });

  it("writes the reservation event trail for a successful forwarded call", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(200);
    expect(getActions(delegation.id)).toHaveLength(1);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(1);
    expect(
      getEvents(delegation.id).filter(
        (event) => event.event_type === "checkpoint_forward_started"
      )
    ).toHaveLength(1);
    expect(
      getEvents(delegation.id).filter(
        (event) => event.event_type === "checkpoint_forward_attached"
      )
    ).toHaveLength(1);
  });

  it("appends the expected transparency event order through checkpoint_forward_attached for a successful execute call", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(getCheckpointTransparencyRows(delegation.id)).toEqual([
      {
        delegation_id: delegation.id,
        reservation_id: null,
        event_type: "delegated_execute_requested",
        actor_kind: "delegate",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: body.reservationId,
        event_type: "checkpoint_action_reserved",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: body.reservationId,
        event_type: "checkpoint_forward_started",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: body.reservationId,
        event_type: "checkpoint_forward_attached",
        actor_kind: "checkpoint",
        agentgate_action_id: "ag-checkpoint-001",
        outcome: null,
        reason_code: null,
      },
    ]);
  });

  it("records the real reservation id on checkpoint_action_reserved", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const reservedRow = getCheckpointTransparencyRows(delegation.id).find(
      (row) => row.event_type === "checkpoint_action_reserved"
    );

    expect(reservedRow).toEqual({
      delegation_id: delegation.id,
      reservation_id: body.reservationId,
      event_type: "checkpoint_action_reserved",
      actor_kind: "checkpoint",
      agentgate_action_id: null,
      outcome: null,
      reason_code: null,
    });
  });

  it("creates distinct reservations for two sequential authenticated calls", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    vi.mocked(agentGateClient.executeBondedAction)
      .mockResolvedValueOnce({ actionId: "ag-checkpoint-001" })
      .mockResolvedValueOnce({ actionId: "ag-checkpoint-002" });

    const firstResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    const secondResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 20,
            payload: { input: "second call" },
          })
        ),
      }
    );

    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    const actions = getActions(delegation.id);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstBody.reservationId).not.toBe(secondBody.reservationId);
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.id)).toEqual([
      firstBody.reservationId,
      secondBody.reservationId,
    ]);
    expect(actions.map((action) => action.agentgate_action_id)).toEqual([
      "ag-checkpoint-001",
      "ag-checkpoint-002",
    ]);
  });

  it("allows an action type that is in delegated scope and reaches AgentGate execute", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite", "file-transform"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "Rewrite or transform",
    });
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            actionType: "file-transform",
            declaredExposureCents: 10,
            payload: { file: "draft.txt" },
          })
        ),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stage: "forwarded",
      forwardState: "forwarded",
      actionType: "file-transform",
      agentgateActionId: "ag-checkpoint-001",
    });
    expect(getActions(delegation.id)).toHaveLength(1);
    expect(agentGateClient.executeBondedAction).toHaveBeenCalledTimes(1);
  });

  it("rejects a disallowed action type and creates no reservation", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            actionType: "delete-file",
            payload: { file: "draft.txt" },
          })
        ),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "ACTION_TYPE_NOT_ALLOWED",
      message: 'Action type "delete-file" is outside delegated scope',
    });
    expect(agentGateClient.executeBondedAction).not.toHaveBeenCalled();
    expect(getActions(delegation.id)).toHaveLength(0);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(0);
    expect(getCheckpointReservationForwardStatus("missing")).toBeNull();
  });

  it("enforces max_actions before creating another reservation", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite"],
      max_actions: 1,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "One action only",
    });
    const { baseUrl } = await startServer();

    const firstResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    const secondResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toEqual({
      ok: false,
      code: "MAX_ACTIONS_EXCEEDED",
      message: "Creating another reservation would exceed max_actions 1",
    });
    expect(agentGateClient.executeBondedAction).toHaveBeenCalledTimes(1);
    expect(getActions(delegation.id)).toHaveLength(1);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(1);
  });

  it("enforces the per-action exposure cap", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 50,
      max_total_exposure_cents: 250,
      description: "Low exposure cap",
    });
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 51,
          })
        ),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "PER_ACTION_EXPOSURE_EXCEEDED",
      message: expect.stringContaining("Declared exposure 51"),
    });
    expect(agentGateClient.executeBondedAction).not.toHaveBeenCalled();
    expect(getActions(delegation.id)).toHaveLength(0);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(0);
  });

  it("enforces max total exposure across existing reservations", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 50,
      max_total_exposure_cents: 100,
      description: "Tight total exposure cap",
    });
    const { baseUrl } = await startServer();

    const firstResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 50,
          })
        ),
      }
    );

    const secondResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 50,
            payload: { input: "second reservation" },
          })
        ),
      }
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toEqual({
      ok: false,
      code: "MAX_TOTAL_EXPOSURE_EXCEEDED",
      message:
        "Projected total effective exposure 120¢ exceeds max_total_exposure_cents 100¢",
    });
    expect(agentGateClient.executeBondedAction).toHaveBeenCalledTimes(1);
    expect(getActions(delegation.id)).toHaveLength(1);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(1);
  });

  it("handles sequential requests near the total exposure limit correctly", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite"],
      max_actions: 5,
      max_exposure_cents: 50,
      max_total_exposure_cents: 120,
      description: "Near-limit sequence",
    });
    const { baseUrl } = await startServer();

    const firstResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 50,
          })
        ),
      }
    );

    const secondResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 50,
            payload: { input: "second" },
          })
        ),
      }
    );

    const thirdResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            declaredExposureCents: 1,
            payload: { input: "third" },
          })
        ),
      }
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(thirdResponse.status).toBe(409);
    await expect(thirdResponse.json()).resolves.toEqual({
      ok: false,
      code: "MAX_TOTAL_EXPOSURE_EXCEEDED",
      message:
        "Projected total effective exposure 122¢ exceeds max_total_exposure_cents 120¢",
    });
    expect(agentGateClient.executeBondedAction).toHaveBeenCalledTimes(2);
    expect(getActions(delegation.id)).toHaveLength(2);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(2);
  });

  it("lands in the pre-attachment failure seam when AgentGate execute fails", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    vi.mocked(agentGateClient.executeBondedAction).mockRejectedValueOnce(
      new Error("AgentGate /v1/actions/execute failed")
    );

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      stage: "pre_attachment_failed",
      code: "AGENTGATE_EXECUTE_FAILED",
      reservationId: expect.any(String),
      message: "AgentGate /v1/actions/execute failed",
    });

    const actions = getActions(delegation.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].forward_state).toBe(CHECKPOINT_FORWARD_STATE_IN_FORWARD);
    expect(actions[0].agentgate_action_id).toBeNull();
    expect(actions[0].outcome).toBe("failed");
    expect(actions[0].resolved_at).not.toBeNull();
    expect(
      getEvents(delegation.id).filter(
        (event) => event.event_type === "checkpoint_forward_failed"
      )
    ).toHaveLength(1);
    expect(getCheckpointTransparencyRows(delegation.id)).toEqual([
      {
        delegation_id: delegation.id,
        reservation_id: null,
        event_type: "delegated_execute_requested",
        actor_kind: "delegate",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: body.reservationId,
        event_type: "checkpoint_action_reserved",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: actions[0].id,
        event_type: "checkpoint_forward_started",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: actions[0].id,
        event_type: "checkpoint_forward_failed",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: "failed",
        reason_code: "pre_attachment_forward_failed",
      },
    ]);
  });

  it("returns DELEGATION_NOT_FOUND when the delegation does not exist", async () => {
    const delegateKeys = generateTestKeys();
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(VALID_DELEGATION_ID, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "DELEGATION_NOT_FOUND",
      message: "Delegation not found",
    });
  });

  it("does not append execute transparency rows for malformed, unauthorized, rejected, or ineligible execute attempts", async () => {
    const delegateKeys = generateTestKeys();
    const wrongSignerKeys = generateTestKeys();
    const acceptedDelegation = createAcceptedDelegation(delegateKeys);
    const pendingDelegation = createDelegation({
      delegatorId: "human-pub-key",
      delegateId: delegateKeys.publicKey,
      scope: {
        allowed_actions: ["email-rewrite"],
        max_actions: 3,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "Rewrite emails",
      },
      delegatorBondId: "human-bond-123",
      ttlSeconds: 3600,
    });
    const { baseUrl } = await startServer();

    const malformedResponse = await fetch(
      `${baseUrl}/v1/delegations/${acceptedDelegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: delegateKeys.publicKey,
            timestamp: new Date().toISOString(),
          },
        }),
      }
    );

    const unauthorizedResponse = await fetch(
      `${baseUrl}/v1/delegations/${acceptedDelegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(acceptedDelegation.id, wrongSignerKeys, {
            delegateId: delegateKeys.publicKey,
          })
        ),
      }
    );

    const rejectedResponse = await fetch(
      `${baseUrl}/v1/delegations/${pendingDelegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(pendingDelegation.id, delegateKeys)),
      }
    );

    const ineligibleResponse = await fetch(
      `${baseUrl}/v1/delegations/${acceptedDelegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(acceptedDelegation.id, delegateKeys, {
            actionType: "file-transform",
          })
        ),
      }
    );

    expect(malformedResponse.status).toBe(400);
    expect(unauthorizedResponse.status).toBe(403);
    expect(rejectedResponse.status).toBe(409);
    expect(ineligibleResponse.status).toBe(409);
    expect(getCheckpointTransparencyRows(acceptedDelegation.id)).toEqual([]);
    expect(getCheckpointTransparencyRows(pendingDelegation.id)).toEqual([]);
    expect(getActions(acceptedDelegation.id)).toHaveLength(0);
    expect(getActions(pendingDelegation.id)).toHaveLength(0);
  });

  it("does not append checkpoint_action_reserved when execution fails before reservation creation", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegationWithScope(delegateKeys, {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "Rewrite emails",
    });
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSignedRequest(delegation.id, delegateKeys, {
            actionType: "file-transform",
          })
        ),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "ACTION_TYPE_NOT_ALLOWED",
    });
    expect(
      getCheckpointTransparencyRows(delegation.id).filter(
        (row) => row.event_type === "checkpoint_action_reserved"
      )
    ).toEqual([]);
  });

  it("rejects a delegation in the wrong state", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createDelegation({
      delegatorId: "human-pub-key",
      delegateId: delegateKeys.publicKey,
      scope: {
        allowed_actions: ["email-rewrite"],
        max_actions: 3,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "Rewrite emails",
      },
      delegatorBondId: "human-bond-123",
      ttlSeconds: 3600,
    });
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "DELEGATION_NOT_ACTIVE",
      message: expect.stringContaining('status "pending"'),
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects a request signed by the wrong key", async () => {
    const delegateKeys = generateTestKeys();
    const wrongSignerKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, wrongSignerKeys, {
      delegateId: delegateKeys.publicKey,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
      message: "auth.signature did not verify for the bound delegate identity",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects a stale timestamp", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const requestBody = buildSignedRequest(delegation.id, delegateKeys, {
      timestamp: staleTimestamp,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "TIMESTAMP_OUT_OF_WINDOW",
      message: "auth.timestamp is outside the allowed freshness window",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("rejects auth.delegateId mismatches with the stored delegate identity", async () => {
    const delegateKeys = generateTestKeys();
    const mismatchedKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const requestBody = buildSignedRequest(delegation.id, mismatchedKeys);

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "DELEGATE_MISMATCH",
      message: "auth.delegateId does not match the bound delegate identity",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
  });

  it("returns RESERVATION_FAILED and leaves no partial reservation when the write transaction fails", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    const db = getDb();
    const originalPrepare = db.prepare.bind(db);

    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO delegation_events")) {
        throw new Error("forced reservation event write failure");
      }

      return originalPrepare(sql);
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "RESERVATION_FAILED",
      message: "Failed to create local checkpoint reservation",
    });
    expect(getActions(delegation.id)).toHaveLength(0);
    expect(getCheckpointReservedEvents(delegation.id)).toHaveLength(0);
  });

  it("rejects requests with missing required fields", async () => {
    const { baseUrl } = await startServer();
    const auth = {
      delegateId: "cHVibGljLWtleQ==",
      timestamp: new Date().toISOString(),
      signature: "c2lnbmF0dXJl",
    };
    const { actionType, payload, declaredExposureCents } = VALID_REQUEST_TEMPLATE;

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType,
          payload,
          declaredExposureCents,
          auth: {
            delegateId: auth.delegateId,
            timestamp: auth.timestamp,
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("rejects invalid exposure values", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "c2lnbmF0dXJl",
          },
          declaredExposureCents: 0,
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("declaredExposureCents"),
    });
  });

  it("rejects malformed timestamps", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: "not-a-timestamp",
            signature: "c2lnbmF0dXJl",
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("auth.timestamp"),
    });
  });

  it("rejects malformed signatures", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "***not-base64***",
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("auth.signature"),
    });
  });

  it("rejects unknown extra fields with strict request parsing", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${VALID_DELEGATION_ID}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...VALID_REQUEST_TEMPLATE,
          auth: {
            delegateId: "cHVibGljLWtleQ==",
            timestamp: new Date().toISOString(),
            signature: "c2lnbmF0dXJl",
          },
          unexpected: true,
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Unrecognized key"),
    });
  });

  it("rejects an invalid delegation id in the route", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/v1/delegations/not-a-uuid/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...VALID_REQUEST_TEMPLATE,
        auth: {
          delegateId: "cHVibGljLWtleQ==",
          timestamp: new Date().toISOString(),
          signature: "c2lnbmF0dXJl",
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_DELEGATION_ID",
      message: "delegationId: Invalid uuid",
    });
  });
});

describe("checkpoint server — finalize endpoint", () => {
  function createForwardedReservation(
    delegationId: string,
    agentgateActionId = "ag-checkpoint-001"
  ): string {
    const reservation = reserveCheckpointAction({
      delegationId,
      actorPublicKey: getDelegation(delegationId)!.delegate_id,
      actionType: "email-rewrite",
      payload: { input: "Please rewrite this email" },
      declaredExposureCents: 83,
    });

    startCheckpointForwardAttempt(reservation.reservationId);
    attachCheckpointForwardedAction(
      reservation.reservationId,
      agentgateActionId
    );

    return reservation.reservationId;
  }

  it("finalizes a forwarded checkpoint reservation as success through the explicit endpoint", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const reservationId = createForwardedReservation(delegation.id);
    const { baseUrl } = await startServer();
    writeResolverIdentityFile();

    vi.spyOn(agentGateClient, "resolveAgentGateAction").mockResolvedValue({
      ok: true,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      stage: "finalized",
      reservationId,
      agentgateActionId: "ag-checkpoint-001",
      outcome: "success",
    });

    const action = getActions(delegation.id)[0];
    expect(action.forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(action.agentgate_action_id).toBe("ag-checkpoint-001");
    expect(action.outcome).toBe("success");
    expect(action.resolved_at).not.toBeNull();
  });

  it("appends the expected transparency event order through checkpoint_forward_finalized for a successful full path", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const { baseUrl } = await startServer();
    writeResolverIdentityFile();

    vi.spyOn(agentGateClient, "resolveAgentGateAction").mockResolvedValue({
      ok: true,
    });

    const executeResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSignedRequest(delegation.id, delegateKeys)),
      }
    );

    expect(executeResponse.status).toBe(200);
    const executeBody = await executeResponse.json();

    const finalizeResponse = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${executeBody.reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      }
    );

    expect(finalizeResponse.status).toBe(200);
    await expect(finalizeResponse.json()).resolves.toEqual({
      ok: true,
      stage: "finalized",
      reservationId: executeBody.reservationId,
      agentgateActionId: "ag-checkpoint-001",
      outcome: "success",
    });

    expect(getCheckpointTransparencyRows(delegation.id)).toEqual([
      {
        delegation_id: delegation.id,
        reservation_id: null,
        event_type: "delegated_execute_requested",
        actor_kind: "delegate",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: executeBody.reservationId,
        event_type: "checkpoint_action_reserved",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: executeBody.reservationId,
        event_type: "checkpoint_forward_started",
        actor_kind: "checkpoint",
        agentgate_action_id: null,
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: executeBody.reservationId,
        event_type: "checkpoint_forward_attached",
        actor_kind: "checkpoint",
        agentgate_action_id: "ag-checkpoint-001",
        outcome: null,
        reason_code: null,
      },
      {
        delegation_id: delegation.id,
        reservation_id: executeBody.reservationId,
        event_type: "checkpoint_forward_finalized",
        actor_kind: "resolver",
        agentgate_action_id: "ag-checkpoint-001",
        outcome: "success",
        reason_code: null,
      },
    ]);
  });

  it("finalizes a forwarded checkpoint reservation as failed through the explicit endpoint", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const reservationId = createForwardedReservation(
      delegation.id,
      "ag-checkpoint-002"
    );
    const { baseUrl } = await startServer();
    writeResolverIdentityFile("resolver-identity-456");

    vi.spyOn(agentGateClient, "resolveAgentGateAction").mockResolvedValue({
      ok: true,
    });

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "failed" }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      stage: "finalized",
      reservationId,
      agentgateActionId: "ag-checkpoint-002",
      outcome: "failed",
    });

    const action = getActions(delegation.id)[0];
    expect(action.outcome).toBe("failed");
    expect(action.resolved_at).not.toBeNull();
  });

  it("rejects a non-forwarded or non-attached reservation", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const reservation = reserveCheckpointAction({
      delegationId: delegation.id,
      actorPublicKey: delegateKeys.publicKey,
      actionType: "email-rewrite",
      payload: { input: "Please rewrite this email" },
      declaredExposureCents: 83,
    });
    const { baseUrl } = await startServer();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${reservation.reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "not_ready",
      code: "NOT_FORWARDED",
      reservationId: reservation.reservationId,
      message: "Checkpoint reservation is not currently forwarded",
    });
  });

  it("rejects duplicate finalization", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const reservationId = createForwardedReservation(delegation.id);
    finalizeCheckpointForwardedAction(reservationId, "success");
    const { baseUrl } = await startServer();
    writeResolverIdentityFile();

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "not_ready",
      code: "ALREADY_FINALIZED",
      reservationId,
      message: "Checkpoint reservation is already finalized",
    });
  });

  it("surfaces AgentGate resolution failure clearly", async () => {
    const delegateKeys = generateTestKeys();
    const delegation = createAcceptedDelegation(delegateKeys);
    const reservationId = createForwardedReservation(delegation.id);
    const { baseUrl } = await startServer();
    writeResolverIdentityFile();

    vi.spyOn(agentGateClient, "resolveAgentGateAction").mockRejectedValue(
      new Error("AgentGate resolution failed")
    );

    const response = await fetch(
      `${baseUrl}/v1/delegations/${delegation.id}/actions/${reservationId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome: "success" }),
      }
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "resolution_failed",
      code: "AGENTGATE_RESOLVE_FAILED",
      reservationId,
      message: "AgentGate resolution failed",
    });

    const action = getActions(delegation.id)[0];
    expect(action.forward_state).toBe(CHECKPOINT_FORWARD_STATE_FORWARDED);
    expect(action.agentgate_action_id).toBe("ag-checkpoint-001");
    expect(action.outcome).toBeNull();
    expect(action.resolved_at).toBeNull();
  });
});
