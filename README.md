# Delegation Identity Proof

A proof-of-concept for bounded human-to-agent delegation with economic accountability. A human delegates scoped authority to an agent, both parties post bonds, and actions are settled through AgentGate.

## Why This Exists

Current agent identity systems answer "who is this agent?" but not "who authorized it, to do what, within what limits, and with what accountability?" Delegation Identity Proof fills that gap. The human has skin in the game too — not just the agent.

## How It Relates to AgentGate

[AgentGate](https://github.com/selfradiance/agentgate) is the enforcement substrate. This project calls AgentGate's REST API for identity registration, bond management, action execution, and resolution. No changes to AgentGate core were needed — this is a client, not an extension.

AgentGate must be running for this project to work.

## How It Works

1. **Human creates delegation** — defines scope (allowed actions, exposure limits, time bounds), locks a commitment bond on AgentGate
2. **Agent accepts** — posts its own bond (two-phase: claim → bond → finalize)
3. **Agent acts within scope** — scope validated locally with AgentGate-aligned 1.2× capacity math
4. **Resolver resolves** — each action settled via AgentGate
5. **Delegation completes** — aggregate outcome computed, bonds released or slashed

## What's Implemented

- 6-state machine: pending → accepted → active → settling → completed (+ failed)
- Terminal reason separation: exhausted, closed, revoked, expired
- Two-phase transaction pattern (no SQLite locks across HTTP calls)
- Zod-validated delegation scope with capacity math
- Dual bond mechanics (human commitment deposit + agent action bond)
- CLI with 7 commands: delegate, accept, act, resolve, revoke, close, status
- Ed25519 signed requests for human, agent, and resolver roles
- Bond TTL alignment (human bond = delegation TTL + 1hr margin)
- Auto-complete on scope exhaustion
- Crash recovery for orphaned action reservations
- v0.2 Baby Step 8: `forwarded` checkpoint reservations can now finalize locally as `success` or `failed` through a guarded helper that writes `outcome` and `resolved_at`, creating the first narrow local finalization seam without retries or revert logic

## Quick Start

```bash
# 1. Start AgentGate
cd ~/Desktop/projects/agentgate && npm run restart

# 2. Run Delegation Proof
cd ~/Desktop/projects/delegation-identity-proof
cp .env.example .env  # add AGENTGATE_REST_KEY
npm install

# Create a delegation
npx tsx src/cli.ts delegate --max-actions 5 --max-exposure 500 --ttl 3600

# Agent accepts
npx tsx src/cli.ts accept --delegation-id <id>

# Agent acts
npx tsx src/cli.ts act --delegation-id <id> --action "file-transform" --exposure 100

# Check status
npx tsx src/cli.ts status --delegation-id <id>
```

## Scope / Non-Goals (v0.1)

- Human bond is a commitment deposit, not slashable (v0.2)
- Scope enforcement is client-side only — a malicious agent with direct API access can bypass (v0.2)
- Payload convention in AgentGate is unenforceable (opaque)
- Bond TTL ceiling of 24 hours
- No protection against human grief-revoke attacks (v0.2)
- Single-hop delegation only — no recursive chain-of-custody (v0.2)

## Tests

130 tests across 8 files. 3 integration tests (opt-in via `RUN_INTEGRATION_TESTS=1`, requires live AgentGate).

```bash
npm test
```

## Related Projects

- [AgentGate](https://github.com/selfradiance/agentgate) — the core execution engine
- [MCP Firewall](https://github.com/selfradiance/agentgate-mcp-firewall) — governance proxy for MCP tool calls

## Status

v0.1.0 shipped and credible. v0.2 Baby Step 8 adds the first explicit local finalization seam on checkpoint reservations after `forwarded`. Still no revert or retry flow. 130 tests.

Planned next work: [v0.2 server-mediated scope enforcement](docs/v0.2-server-mediated-scope-enforcement.md).

## License

MIT
