export const MAX_BOND_TTL_SECONDS = 86_400;
export const BOND_TTL_MARGIN_SECONDS = 3_600;
export const MAX_DELEGATION_TTL_SECONDS =
  MAX_BOND_TTL_SECONDS - BOND_TTL_MARGIN_SECONDS;

export function getHumanBondTtlSeconds(delegationTtlSeconds: number): number {
  if (!Number.isInteger(delegationTtlSeconds) || delegationTtlSeconds <= 0) {
    throw new Error("Delegation TTL must be a positive integer number of seconds");
  }

  if (delegationTtlSeconds > MAX_DELEGATION_TTL_SECONDS) {
    throw new Error(
      `Delegation TTL cannot exceed ${MAX_DELEGATION_TTL_SECONDS} seconds because AgentGate bond TTLs are capped at ${MAX_BOND_TTL_SECONDS} seconds`
    );
  }

  return delegationTtlSeconds + BOND_TTL_MARGIN_SECONDS;
}

export function getAgentBondTtlSeconds(
  expiresAtIso: string,
  now: Date = new Date()
): number {
  const expiresAt = new Date(expiresAtIso);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(`Invalid delegation expiration timestamp: ${expiresAtIso}`);
  }

  const remainingSeconds = Math.ceil(
    (expiresAt.getTime() - now.getTime()) / 1000
  );
  if (remainingSeconds <= 0) {
    throw new Error("Delegation has already expired");
  }

  const ttlSeconds = remainingSeconds + BOND_TTL_MARGIN_SECONDS;
  if (ttlSeconds > MAX_BOND_TTL_SECONDS) {
    throw new Error(
      `Remaining delegation lifetime requires a bond TTL longer than AgentGate's ${MAX_BOND_TTL_SECONDS}-second cap`
    );
  }

  return ttlSeconds;
}
