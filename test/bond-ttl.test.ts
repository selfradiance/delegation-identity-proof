import { describe, expect, it } from "vitest";
import {
  BOND_TTL_MARGIN_SECONDS,
  MAX_BOND_TTL_SECONDS,
  MAX_DELEGATION_TTL_SECONDS,
  getAgentBondTtlSeconds,
  getHumanBondTtlSeconds,
} from "../src/bond-ttl";

describe("bond TTL helpers", () => {
  it("adds the configured safety margin to the human bond TTL", () => {
    expect(getHumanBondTtlSeconds(3600)).toBe(3600 + BOND_TTL_MARGIN_SECONDS);
  });

  it("rejects delegation TTLs that cannot fit under AgentGate's cap", () => {
    expect(() =>
      getHumanBondTtlSeconds(MAX_DELEGATION_TTL_SECONDS + 1)
    ).toThrow();
  });

  it("derives agent bond TTL from remaining delegation lifetime", () => {
    const now = new Date("2026-03-29T12:00:00.000Z");
    const expiresAt = new Date(
      now.getTime() + 2 * 3600 * 1000
    ).toISOString();

    expect(getAgentBondTtlSeconds(expiresAt, now)).toBe(
      2 * 3600 + BOND_TTL_MARGIN_SECONDS
    );
  });

  it("rejects expired delegations and over-cap lifetimes", () => {
    const now = new Date("2026-03-29T12:00:00.000Z");
    expect(() => getAgentBondTtlSeconds("2026-03-29T11:59:59.000Z", now)).toThrow();

    const tooFar = new Date(
      now.getTime() + (MAX_BOND_TTL_SECONDS - BOND_TTL_MARGIN_SECONDS + 1) * 1000
    ).toISOString();
    expect(() => getAgentBondTtlSeconds(tooFar, now)).toThrow();
  });
});
