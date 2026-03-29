# Delegation Identity Proof

A proof-of-concept demonstrating delegated authority with economic accountability. A human delegates bounded authority to an AI agent. Both parties post bonds. The agent acts within the delegated scope. AgentGate settles the outcome.

## What Problem It Solves

Today's agent identity approaches (OAuth tokens, API keys, CIBA flows) answer "is this agent authenticated?" but not "who authorized this agent to do this specific thing, and what happens if it goes wrong?"

AgentGate already makes bad actions costly. The delegation proof adds the question that comes *before* the action: who gave the agent permission, under what constraints, and with what accountability?

## Architecture

```
Human (CLI)  →  Delegation Engine  →  AgentGate REST API
Agent (CLI)  →  Scope Validator    →  Ed25519 Signed Requests
                SQLite (local)         Bonds & Settlement
```

AgentGate remains semantically unaware of delegations. The delegation layer is client-side governance with a full audit trail.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your AGENTGATE_REST_KEY

# Run unit tests (no AgentGate needed)
npm test

# Run the CLI
npx tsx src/cli.ts --help
```

## CLI Commands

```bash
# Human: create a delegation
npx tsx src/cli.ts delegate \
  --to <agent-public-key> \
  --actions email-rewrite,file-transform \
  --max-actions 3 \
  --max-exposure 83 \
  --max-total-exposure 250 \
  --bond 100 \
  --ttl 3600 \
  --description "Rewrite up to 3 emails, max 83 cents exposure each"

# Agent: accept a delegation
npx tsx src/cli.ts accept --delegation <id> --bond 100

# Agent: act under delegation
npx tsx src/cli.ts act \
  --delegation <id> \
  --action-type email-rewrite \
  --exposure 83 \
  --payload '{"instruction": "make it formal"}'

# Resolver: resolve an action
npx tsx src/cli.ts resolve --action <id> --outcome success

# Human: revoke or close
npx tsx src/cli.ts revoke --delegation <id>
npx tsx src/cli.ts close --delegation <id>

# Anyone: view full accountability trail
npx tsx src/cli.ts status --delegation <id>
```

## Delegation Lifecycle

1. **Human creates delegation** — defines scope, locks commitment bond in AgentGate
2. **Agent accepts** — posts its own bond (two-phase: claim → bond → finalize)
3. **Agent acts within scope** — scope validated locally with AgentGate-aligned 1.2× capacity math
4. **Resolver resolves** — each action settled via AgentGate
5. **Delegation completes** — aggregate outcome computed, bonds released or slashed

## State Machine

Six operational states with terminal reason separation:

| State | Meaning |
|---|---|
| `pending` | Waiting for agent to accept |
| `accepted` | Agent accepted, no actions yet |
| `active` | At least one action executed |
| `settling` | No new actions, open actions still resolving |
| `completed` | Terminal — all obligations resolved |
| `failed` | Terminal — unrecoverable system error |

Terminal reasons: `exhausted`, `closed`, `revoked`, `expired`

## Testing

```bash
# Unit tests (75 tests, no external dependencies)
npm test

# Integration tests (requires AgentGate running)
# 1. Start AgentGate: cd ~/Desktop/projects/agentgate && npm run restart
# 2. Ensure .env has AGENTGATE_REST_KEY
# 3. Run: npm test
# Integration tests auto-skip when AgentGate is unavailable.
```

## Tech Stack

- TypeScript, Node.js 20+, tsx
- Vitest for testing
- Zod for validation
- better-sqlite3 for local SQLite storage
- Ed25519 signing via AgentGate client pattern
- AgentGate REST API

## Known Limitations (v0.1)

1. Human bond is a commitment deposit, not slashable (v0.2)
2. Scope enforcement is client-side only (v0.2)
3. Payload convention in AgentGate is unenforceable
4. Bond TTL ceiling of 24 hours
5. No protection against human grief-revoke attacks (v0.2)

See the [v0.1 spec](DELEGATION_IDENTITY_PROOF_v0.1_SPEC_REV3.md) for full details.

## License

MIT
