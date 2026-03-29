import { z } from "zod";

// --- Zod schemas ---

export const DelegationScopeSchema = z.object({
  allowed_actions: z.array(z.string().min(1)).min(1),
  max_actions: z.number().int().positive(),
  max_exposure_cents: z.number().int().positive(),
  max_total_exposure_cents: z.number().int().positive(),
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
