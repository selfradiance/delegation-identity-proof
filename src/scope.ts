import { z } from "zod";

// --- Zod schemas ---

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function containsPathTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

const RelativePathPrefixSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolutePath(value), {
    message: "Path prefixes must be relative",
  })
  .refine((value) => !containsPathTraversal(value), {
    message: "Path prefixes must not contain path traversal",
  });

export const DelegationScopeSchema = z.object({
  allowed_actions: z.array(z.string().min(1)).min(1),
  max_actions: z.number().int().positive(),
  max_exposure_cents: z.number().int().positive(),
  max_total_exposure_cents: z.number().int().positive(),
  allowed_path_prefixes: z.array(RelativePathPrefixSchema).min(1).optional(),
  allowed_operations: z.array(z.string().min(1)).min(1).optional(),
  description: z.string().min(1),
});

export type DelegationScope = z.infer<typeof DelegationScopeSchema>;

// --- Capacity math ---

/**
 * AgentGate calculates effective exposure as ceil(declared × 1.2).
 * The scope validator must replicate this math exactly.
 */
export function effectiveExposure(declaredCents: number): number {
  return Math.ceil(declaredCents * 1.2);
}

// --- Scope validation ---

export interface ScopeCheckResult {
  valid: boolean;
  reason?: string;
  reasonCode?: ResourceScopeRejectionCode;
}

export const RESOURCE_SCOPE_REJECTION_CODES = [
  "RESOURCE_PATH_REQUIRED",
  "RESOURCE_PATH_INVALID",
  "RESOURCE_PATH_ABSOLUTE",
  "RESOURCE_PATH_TRAVERSAL",
  "RESOURCE_PATH_NOT_ALLOWED",
  "RESOURCE_OPERATION_REQUIRED",
  "RESOURCE_OPERATION_INVALID",
  "RESOURCE_OPERATION_NOT_ALLOWED",
] as const;

export type ResourceScopeRejectionCode =
  typeof RESOURCE_SCOPE_REJECTION_CODES[number];

export function isResourceScopeRejectionCode(
  code: string
): code is ResourceScopeRejectionCode {
  return RESOURCE_SCOPE_REJECTION_CODES.includes(
    code as ResourceScopeRejectionCode
  );
}

/**
 * Validates whether a proposed action fits within the delegation scope.
 *
 * @param scope - The delegation's scope constraints
 * @param actionType - The action type being attempted
 * @param declaredExposureCents - The declared exposure for this action
 * @param actionsTaken - Number of actions already executed under this delegation
 * @param totalEffectiveExposureSoFar - Sum of effective exposures for all prior actions
 */
export function validateAction(
  scope: DelegationScope,
  actionType: string,
  declaredExposureCents: number,
  actionsTaken: number,
  totalEffectiveExposureSoFar: number
): ScopeCheckResult {
  if (!Number.isInteger(declaredExposureCents) || declaredExposureCents <= 0) {
    return {
      valid: false,
      reason: "Declared exposure must be a positive integer number of cents",
    };
  }

  // Check action type is in allowlist
  if (!scope.allowed_actions.includes(actionType)) {
    return {
      valid: false,
      reason: `Action type "${actionType}" not in allowed list: [${scope.allowed_actions.join(", ")}]`,
    };
  }

  // Check action count limit
  if (actionsTaken >= scope.max_actions) {
    return {
      valid: false,
      reason: `Action count ${actionsTaken} has reached max_actions ${scope.max_actions}`,
    };
  }

  // Check per-action exposure limit
  if (declaredExposureCents > scope.max_exposure_cents) {
    return {
      valid: false,
      reason: `Declared exposure ${declaredExposureCents}¢ exceeds max_exposure_cents ${scope.max_exposure_cents}¢`,
    };
  }

  // Check total effective exposure limit (using 1.2× multiplier)
  const newEffective = effectiveExposure(declaredExposureCents);
  const projectedTotal = totalEffectiveExposureSoFar + newEffective;
  if (projectedTotal > scope.max_total_exposure_cents) {
    return {
      valid: false,
      reason: `Projected total effective exposure ${projectedTotal}¢ (${totalEffectiveExposureSoFar}¢ + ${newEffective}¢) exceeds max_total_exposure_cents ${scope.max_total_exposure_cents}¢`,
    };
  }

  return { valid: true };
}

export function validatePayloadResourceScope(
  scope: DelegationScope,
  payload: unknown
): ScopeCheckResult {
  const hasPathConstraints = scope.allowed_path_prefixes !== undefined;
  const hasOperationConstraints = scope.allowed_operations !== undefined;

  if (!hasPathConstraints && !hasOperationConstraints) {
    return { valid: true };
  }

  const payloadObject =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  if (hasPathConstraints) {
    const path = payloadObject?.path;

    if (path === undefined) {
      return {
        valid: false,
        reasonCode: "RESOURCE_PATH_REQUIRED",
        reason: "Checkpoint payload must declare payload.path for this delegated scope",
      };
    }

    if (typeof path !== "string" || path.trim().length === 0) {
      return {
        valid: false,
        reasonCode: "RESOURCE_PATH_INVALID",
        reason: "Checkpoint payload path must be a non-empty string",
      };
    }

    if (isAbsolutePath(path)) {
      return {
        valid: false,
        reasonCode: "RESOURCE_PATH_ABSOLUTE",
        reason: "Checkpoint payload path must be relative",
      };
    }

    if (containsPathTraversal(path)) {
      return {
        valid: false,
        reasonCode: "RESOURCE_PATH_TRAVERSAL",
        reason: "Checkpoint payload path must not contain path traversal",
      };
    }

    if (!scope.allowed_path_prefixes!.some((prefix) => path.startsWith(prefix))) {
      return {
        valid: false,
        reasonCode: "RESOURCE_PATH_NOT_ALLOWED",
        reason: `Checkpoint payload path "${path}" is outside delegated path prefixes: [${scope.allowed_path_prefixes!.join(", ")}]`,
      };
    }
  }

  if (hasOperationConstraints) {
    const operation = payloadObject?.operation;

    if (operation === undefined) {
      return {
        valid: false,
        reasonCode: "RESOURCE_OPERATION_REQUIRED",
        reason:
          "Checkpoint payload must declare payload.operation for this delegated scope",
      };
    }

    if (typeof operation !== "string" || operation.trim().length === 0) {
      return {
        valid: false,
        reasonCode: "RESOURCE_OPERATION_INVALID",
        reason: "Checkpoint payload operation must be a non-empty string",
      };
    }

    if (!scope.allowed_operations!.includes(operation)) {
      return {
        valid: false,
        reasonCode: "RESOURCE_OPERATION_NOT_ALLOWED",
        reason: `Checkpoint payload operation "${operation}" is outside delegated operations: [${scope.allowed_operations!.join(", ")}]`,
      };
    }
  }

  return { valid: true };
}
