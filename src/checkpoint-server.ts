import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  ExecuteDelegationPathParamsSchema,
  ExecuteDelegationRequestSchema,
  formatSchemaIssue,
} from "./checkpoint-schema";
import {
  CheckpointForwardTransitionError,
  CheckpointReservationError,
  executeCheckpointForwardHandoff,
  getDelegation,
  reserveCheckpointAction,
  startCheckpointForwardAttempt,
} from "./delegation";
import {
  verifyCheckpointRequestSignature,
  type CheckpointSignableRequest,
} from "./checkpoint-auth";

export type CheckpointErrorCode =
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_JSON"
  | "INVALID_DELEGATION_ID"
  | "INVALID_REQUEST"
  | "DELEGATION_NOT_FOUND"
  | "DELEGATION_NOT_ACTIVE"
  | "DELEGATE_MISMATCH"
  | "TIMESTAMP_OUT_OF_WINDOW"
  | "INVALID_SIGNATURE"
  | "ACTION_TYPE_NOT_ALLOWED"
  | "MAX_ACTIONS_EXCEEDED"
  | "PER_ACTION_EXPOSURE_EXCEEDED"
  | "MAX_TOTAL_EXPOSURE_EXCEEDED"
  | "RESERVATION_FAILED"
  | "NOT_IN_FORWARD"
  | "ALREADY_FORWARDED"
  | "ALREADY_FINALIZED"
  | "PRE_ATTACHMENT_FAILED"
  | "FORWARD_TRANSITION_FAILED"
  | "AGENTGATE_EXECUTE_FAILED";

interface CheckpointErrorResponse {
  ok: false;
  code: CheckpointErrorCode;
  message: string;
  stage?: "not_ready" | "pre_attachment_failed";
  reservationId?: string;
}

interface CheckpointSuccessResponse {
  ok: true;
  stage: "forwarded";
  forwardState: "forwarded";
  delegationId: string;
  actionType: string;
  reservationId: string;
  agentgateActionId: string;
}

type CheckpointResponse = CheckpointErrorResponse | CheckpointSuccessResponse;

const EXECUTE_ROUTE_PATTERN = /^\/v1\/delegations\/([^/]+)\/execute$/;
const TIMESTAMP_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: CheckpointResponse
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(rawBody);
}

function getExecuteRouteMatch(urlString: string | undefined): RegExpMatchArray | null {
  if (!urlString) return null;
  const url = new URL(urlString, "http://127.0.0.1");
  return url.pathname.match(EXECUTE_ROUTE_PATTERN);
}

function buildInvalidRequestMessage(message: string, fieldPath?: string): string {
  if (!fieldPath) {
    return message;
  }

  return `${fieldPath}: ${message}`;
}

function canAcceptDelegatedExecution(
  status: string,
  expiresAt: string,
  nowMs: number
): { ok: true } | { ok: false; message: string } {
  if (status !== "accepted" && status !== "active") {
    return {
      ok: false,
      message: `Delegation status "${status}" cannot accept delegated execution`,
    };
  }

  if (Date.parse(expiresAt) <= nowMs) {
    return {
      ok: false,
      message: "Delegation has expired",
    };
  }

  return { ok: true };
}

function isTimestampWithinFreshnessWindow(timestamp: string, nowMs: number): boolean {
  const parsed = Date.parse(timestamp);
  return Math.abs(nowMs - parsed) <= TIMESTAMP_FRESHNESS_WINDOW_MS;
}

const CHECKPOINT_NOT_READY_MESSAGES = {
  NOT_FOUND: "Checkpoint reservation not found",
  NOT_IN_FORWARD: "Checkpoint reservation is not currently in_forward",
  ALREADY_FORWARDED:
    "Checkpoint reservation already has an attached AgentGate action id",
  ALREADY_FINALIZED: "Checkpoint reservation is already finalized",
  PRE_ATTACHMENT_FAILED:
    "Checkpoint reservation already failed before attachment",
} as const;

export async function handleCheckpointRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const routeMatch = getExecuteRouteMatch(req.url);

  if (!routeMatch) {
    sendJson(res, 404, {
      ok: false,
      code: "NOT_FOUND",
      message: "Route not found",
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Only POST is supported for this route",
    });
    return;
  }

  const pathResult = ExecuteDelegationPathParamsSchema.safeParse({
    delegationId: decodeURIComponent(routeMatch[1]),
  });

  if (!pathResult.success) {
    const issue = pathResult.error.issues[0];
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_DELEGATION_ID",
      message: buildInvalidRequestMessage(
        issue?.message ?? "Invalid delegation id",
        issue ? formatSchemaIssue(issue.path) : undefined
      ),
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_JSON",
      message: "Request body must be valid JSON",
    });
    return;
  }

  const requestResult = ExecuteDelegationRequestSchema.safeParse(body);
  if (!requestResult.success) {
    const issue = requestResult.error.issues[0];
    sendJson(res, 400, {
      ok: false,
      code: "INVALID_REQUEST",
      message: buildInvalidRequestMessage(
        issue?.message ?? "Invalid request body",
        issue ? formatSchemaIssue(issue.path) : undefined
      ),
    });
    return;
  }

  const delegation = getDelegation(pathResult.data.delegationId);
  if (!delegation) {
    sendJson(res, 404, {
      ok: false,
      code: "DELEGATION_NOT_FOUND",
      message: "Delegation not found",
    });
    return;
  }

  const nowMs = Date.now();
  const activeCheck = canAcceptDelegatedExecution(
    delegation.status,
    delegation.expires_at,
    nowMs
  );
  if (!activeCheck.ok) {
    sendJson(res, 409, {
      ok: false,
      code: "DELEGATION_NOT_ACTIVE",
      message: activeCheck.message,
    });
    return;
  }

  if (requestResult.data.auth.delegateId !== delegation.delegate_id) {
    sendJson(res, 403, {
      ok: false,
      code: "DELEGATE_MISMATCH",
      message: "auth.delegateId does not match the bound delegate identity",
    });
    return;
  }

  if (!isTimestampWithinFreshnessWindow(requestResult.data.auth.timestamp, nowMs)) {
    sendJson(res, 403, {
      ok: false,
      code: "TIMESTAMP_OUT_OF_WINDOW",
      message: "auth.timestamp is outside the allowed freshness window",
    });
    return;
  }

  const signableRequest: CheckpointSignableRequest = {
    delegationId: pathResult.data.delegationId,
    delegateId: requestResult.data.auth.delegateId,
    actionType: requestResult.data.actionType,
    declaredExposureCents: requestResult.data.declaredExposureCents,
    payload: requestResult.data.payload,
    timestamp: requestResult.data.auth.timestamp,
  };

  if (
    !verifyCheckpointRequestSignature(
      signableRequest,
      requestResult.data.auth.signature,
      delegation.delegate_id
    )
  ) {
    sendJson(res, 403, {
      ok: false,
      code: "INVALID_SIGNATURE",
      message: "auth.signature did not verify for the bound delegate identity",
    });
    return;
  }

  try {
    const reservation = reserveCheckpointAction({
      delegationId: pathResult.data.delegationId,
      actorPublicKey: requestResult.data.auth.delegateId,
      actionType: requestResult.data.actionType,
      payload: requestResult.data.payload,
      declaredExposureCents: requestResult.data.declaredExposureCents,
    });

    try {
      startCheckpointForwardAttempt(reservation.reservationId);
    } catch (error) {
      if (error instanceof CheckpointForwardTransitionError) {
        sendJson(res, 500, {
          ok: false,
          code: "FORWARD_TRANSITION_FAILED",
          message: error.message,
          reservationId: reservation.reservationId,
        });
        return;
      }

      throw error;
    }

    const handoff = await executeCheckpointForwardHandoff(
      reservation.reservationId
    );

    if (!handoff.ok) {
      if (handoff.stage === "not_ready") {
        sendJson(res, handoff.code === "NOT_FOUND" ? 404 : 409, {
          ok: false,
          stage: "not_ready",
          code: handoff.code,
          reservationId: handoff.reservationId,
          message: CHECKPOINT_NOT_READY_MESSAGES[handoff.code],
        });
        return;
      }

      sendJson(res, 502, {
        ok: false,
        stage: "pre_attachment_failed",
        code: handoff.code,
        reservationId: handoff.reservationId,
        message: handoff.message,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      stage: "forwarded",
      forwardState: "forwarded",
      delegationId: reservation.delegation.id,
      actionType: requestResult.data.actionType,
      reservationId: handoff.reservationId,
      agentgateActionId: handoff.agentgateActionId,
    });
  } catch (error) {
    if (error instanceof CheckpointReservationError) {
      const statusCode =
        error.code === "DELEGATION_NOT_FOUND"
          ? 404
          : error.code === "DELEGATE_MISMATCH"
            ? 403
            : error.code === "ACTION_TYPE_NOT_ALLOWED" ||
                error.code === "MAX_ACTIONS_EXCEEDED" ||
                error.code === "PER_ACTION_EXPOSURE_EXCEEDED" ||
                error.code === "MAX_TOTAL_EXPOSURE_EXCEEDED"
              ? 409
            : 500;

      sendJson(res, statusCode, {
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    throw error;
  }
}

export function createCheckpointServer() {
  return createServer((req, res) => {
    void handleCheckpointRequest(req, res).catch(() => {
      if (res.writableEnded) {
        return;
      }

      sendJson(res, 500, {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Unexpected checkpoint server error",
      });
    });
  });
}
