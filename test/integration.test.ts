// Integration tests against live AgentGate.
// These tests require:
//   1. AgentGate running (cd ~/Desktop/projects/agentgate && npm run restart)
//   2. AGENTGATE_URL and AGENTGATE_REST_KEY set in .env
//   3. RUN_INTEGRATION_TESTS=1 when invoking npm test
//
// Tests are skipped automatically unless AgentGate is configured and
// RUN_INTEGRATION_TESTS=1 is set explicitly.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  loadOrCreateKeypair,
  createIdentity,
  postBond,
  executeBondedAction,
  resolveAgentGateAction,
  type AgentKeys,
} from "../src/agentgate-client";
import { effectiveExposure } from "../src/scope";
import fs from "fs";
import "dotenv/config";

const HAS_AGENTGATE =
  process.env.RUN_INTEGRATION_TESTS === "1" &&
  !!process.env.AGENTGATE_URL &&
  !!process.env.AGENTGATE_REST_KEY &&
  !process.env.AGENTGATE_REST_KEY.includes("your-");

// Use separate identity files for human, agent, and resolver roles
const HUMAN_IDENTITY = "test-human-identity.json";
const AGENT_IDENTITY = "test-agent-identity.json";
const RESOLVER_IDENTITY = "test-resolver-identity.json";

afterAll(() => {
  for (const f of [HUMAN_IDENTITY, AGENT_IDENTITY, RESOLVER_IDENTITY]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe.skipIf(!HAS_AGENTGATE)(
  "Gate #1: Integration tests against live AgentGate",
  () => {
    let humanKeys: AgentKeys;
    let humanIdentityId: string;
    let agentKeys: AgentKeys;
    let agentIdentityId: string;
    let resolverKeys: AgentKeys;
    let resolverIdentityId: string;

    beforeAll(async () => {
      humanKeys = loadOrCreateKeypair(HUMAN_IDENTITY);
      humanIdentityId = await createIdentity(humanKeys, HUMAN_IDENTITY);

      agentKeys = loadOrCreateKeypair(AGENT_IDENTITY);
      agentIdentityId = await createIdentity(agentKeys, AGENT_IDENTITY);

      resolverKeys = loadOrCreateKeypair(RESOLVER_IDENTITY);
      resolverIdentityId = await createIdentity(
        resolverKeys,
        RESOLVER_IDENTITY
      );
    }, 30_000);

    // -----------------------------------------------------------------------
    // Gate #1, Test 1: Idle bond expiry
    // Lock a bond with no action attached. Confirm it locks successfully.
    // Already validated in AgentGate project: bond stays active, sweeper
    // ignores it, reputation undamaged.
    // -----------------------------------------------------------------------
    it(
      "idle bond (no action) can be locked successfully",
      async () => {
        const bondResult = await postBond(
          humanKeys,
          humanIdentityId,
          100, // 100¢ = Tier 1 cap
          60, // 60 second TTL (shortest practical)
          "Gate #1: idle bond expiry test"
        );

        expect(bondResult.bondId).toBeDefined();
        expect(typeof bondResult.bondId).toBe("string");

        console.log(
          `Gate #1 idle bond test: bond ${bondResult.bondId} locked successfully`
        );
      },
      30_000
    );

    // -----------------------------------------------------------------------
    // Gate #1, Test 2: Capacity math alignment
    // Declare 83¢ exposure. Confirm AgentGate accepts it within a 100¢ bond.
    // Our math: ceil(83 × 1.2) = 100¢ effective, which should fit in 100¢.
    // -----------------------------------------------------------------------
    it(
      "capacity math: 83¢ declared fits within 100¢ Tier 1 bond",
      async () => {
        // Verify our local math
        expect(effectiveExposure(83)).toBe(100);

        // Post agent bond
        const bondResult = await postBond(
          agentKeys,
          agentIdentityId,
          100, // 100¢ bond
          300, // 5 min TTL
          "Gate #1: capacity math test"
        );
        const bondId = bondResult.bondId as string;

        // Execute action with 83¢ declared exposure — should succeed
        const actionResult = await executeBondedAction(
          agentKeys,
          agentIdentityId,
          bondId,
          "delegation-test",
          { test: "capacity-math-alignment" },
          83 // 83¢ declared → ceil(83 × 1.2) = 100¢ effective
        );

        expect(actionResult.actionId).toBeDefined();
        console.log(
          `Gate #1 capacity math: 83¢ action accepted (action ${actionResult.actionId})`
        );

        // Resolve the action to clean up
        await resolveAgentGateAction(
          resolverKeys,
          resolverIdentityId,
          actionResult.actionId as string,
          "success"
        );
      },
      30_000
    );

    // -----------------------------------------------------------------------
    // Full lifecycle integration test
    // Human locks bond → agent locks bond → agent acts → resolver resolves
    // -----------------------------------------------------------------------
    it(
      "full delegation lifecycle through AgentGate",
      async () => {
        // Human locks commitment bond (no action)
        const humanBond = await postBond(
          humanKeys,
          humanIdentityId,
          100,
          3600,
          "Integration test: human commitment deposit"
        );
        expect(humanBond.bondId).toBeDefined();

        // Agent locks action bond
        const agentBond = await postBond(
          agentKeys,
          agentIdentityId,
          100,
          3600,
          "Integration test: agent action bond"
        );
        expect(agentBond.bondId).toBeDefined();

        // Agent executes bonded action
        const action = await executeBondedAction(
          agentKeys,
          agentIdentityId,
          agentBond.bondId as string,
          "email-rewrite",
          {
            delegation_id: "integration-test",
            delegator_id: humanKeys.publicKey,
            instruction: "make it formal",
          },
          83
        );
        expect(action.actionId).toBeDefined();

        // Resolver resolves the action
        const resolution = await resolveAgentGateAction(
          resolverKeys,
          resolverIdentityId,
          action.actionId as string,
          "success"
        );
        expect(resolution).toBeDefined();

        console.log("Full lifecycle integration test passed:");
        console.log(`  Human bond: ${humanBond.bondId}`);
        console.log(`  Agent bond: ${agentBond.bondId}`);
        console.log(`  Action: ${action.actionId}`);
        console.log("  Resolution: success");
      },
      30_000
    );
  }
);
