import { describe, it, expect } from "vitest";
import {
  DelegationScopeSchema,
  effectiveExposure,
  validateAction,
  type DelegationScope,
} from "../src/scope";

describe("effectiveExposure — capacity math", () => {
  it("calculates ceil(declared × 1.2)", () => {
    expect(effectiveExposure(100)).toBe(120);
    expect(effectiveExposure(83)).toBe(100); // ceil(99.6) = 100
    expect(effectiveExposure(1)).toBe(2); // ceil(1.2) = 2
    expect(effectiveExposure(10)).toBe(12);
    expect(effectiveExposure(50)).toBe(60);
  });

  it("handles the Tier 1 demo value from spec", () => {
    // Spec example: 83¢ declared → ceil(83 × 1.2) = ceil(99.6) = 100¢
    expect(effectiveExposure(83)).toBe(100);
  });
});

describe("DelegationScopeSchema — validation", () => {
  it("accepts a valid scope", () => {
    const scope = {
      allowed_actions: ["email-rewrite"],
      max_actions: 3,
      max_exposure_cents: 83,
      max_total_exposure_cents: 250,
      description: "Rewrite up to 3 emails",
    };
    expect(DelegationScopeSchema.parse(scope)).toEqual(scope);
  });

  it("rejects empty allowed_actions", () => {
    expect(() =>
      DelegationScopeSchema.parse({
        allowed_actions: [],
        max_actions: 3,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "test",
      })
    ).toThrow();
  });

  it("rejects zero max_actions", () => {
    expect(() =>
      DelegationScopeSchema.parse({
        allowed_actions: ["email-rewrite"],
        max_actions: 0,
        max_exposure_cents: 83,
        max_total_exposure_cents: 250,
        description: "test",
      })
    ).toThrow();
  });

  it("rejects negative exposure", () => {
    expect(() =>
      DelegationScopeSchema.parse({
        allowed_actions: ["email-rewrite"],
        max_actions: 3,
        max_exposure_cents: -10,
        max_total_exposure_cents: 250,
        description: "test",
      })
    ).toThrow();
  });
});

describe("validateAction — scope checks", () => {
  const scope: DelegationScope = {
    allowed_actions: ["email-rewrite", "file-transform"],
    max_actions: 3,
    max_exposure_cents: 83,
    max_total_exposure_cents: 300,
    description: "Rewrite up to 3 emails, max 83 cents each",
  };

  it("accepts a valid action", () => {
    const result = validateAction(scope, "email-rewrite", 83, 0, 0);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects action type not in allowlist", () => {
    const result = validateAction(scope, "delete-file", 50, 0, 0);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("not in allowed list");
  });

  it("rejects when action count is at max", () => {
    const result = validateAction(scope, "email-rewrite", 50, 3, 0);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("max_actions");
  });

  it("rejects when per-action exposure exceeds limit", () => {
    const result = validateAction(scope, "email-rewrite", 84, 0, 0);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("max_exposure_cents");
  });

  it("rejects when total effective exposure would exceed limit", () => {
    // Two prior actions at 83¢ each → effective = 100¢ each = 200¢ total
    // New action at 83¢ → effective = 100¢ → projected = 300¢ → exactly at limit, should pass
    const result = validateAction(scope, "email-rewrite", 83, 2, 200);
    expect(result.valid).toBe(true);

    // But one more cent pushes it over
    const result2 = validateAction(scope, "email-rewrite", 83, 2, 201);
    expect(result2.valid).toBe(false);
    expect(result2.reason).toContain("max_total_exposure_cents");
  });

  it("uses 1.2× multiplier for total exposure check", () => {
    // declared 50¢ → effective = ceil(50 × 1.2) = 60¢
    // If prior total is 250¢, projected = 250 + 60 = 310 > 300 → reject
    const result = validateAction(scope, "email-rewrite", 50, 0, 250);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("310");
  });

  it("allows second action type from allowlist", () => {
    const result = validateAction(scope, "file-transform", 50, 1, 100);
    expect(result.valid).toBe(true);
  });
});
