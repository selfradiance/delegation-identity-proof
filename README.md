# Delegation Identity Proof

A proof-of-concept for bounded human-to-agent delegation with economic accountability. A human delegates scoped authority to an agent, both parties post bonds, and actions are settled through AgentGate.

v0.5.0 keeps the real narrow checkpoint path, the local transparency log, and the local tamper-evident hash chain. It adds deterministic local resource-scope admission for checkpoint-managed delegated execution: if a delegation scope declares allowed path prefixes or operations, the checkpoint checks simple declared `payload.path` and `payload.operation` fields before reservation and re-checks them before pre-attachment execute handoff. Direct AgentGate calls outside that checkpoint are outside delegation accounting and outside this local transparency log. AgentGate itself remains semantically unchanged.

## Why This Exists

Current agent identity systems answer "who is this agent?" but not "who authorized it, to do what, within what limits, and with what accountability?" Delegation Identity Proof fills that gap. The human has skin in the game too — not just the agent.

## What v0.5 Proves

- Delegated actions are only recognized, accounted for, and bounded when they pass through the local checkpoint in this repo.
- The checkpoint enforces delegation existence, delegate binding, request freshness, allowed action type, per-action exposure, total exposure, and max-actions limits before forwarding anything to AgentGate.
- When optional `allowed_path_prefixes` are present, the checkpoint requires `payload.path` to be a non-empty relative string, rejects path traversal, and requires the path to start with one allowed prefix.
- When optional `allowed_operations` are present, the checkpoint requires `payload.operation` to be a non-empty string equal to one allowed operation.
- Checkpoint resource-scope rejections happen before local reservation and before AgentGate execute handoff, return a machine-readable reason code, and record a local `checkpoint_scope_rejected` event.
- Stored checkpoint payload resource scope is re-checked before pre-attachment execute handoff so the handoff does not rely only on an earlier admission check.
- If a checkpoint reservation survives initial admission but the parent delegation later becomes revoked, settling, or expired before pre-attachment forward/execute preparation, the reservation is failed locally instead of continuing forward.
- The repo keeps an ordered local transparency log for delegation lifecycle events and checkpoint transitions, readable through `npx tsx src/cli.ts status --delegation <id> --log`.
- The local transparency log now has a local tamper-evident hash chain. It is local only. It can detect in-place edits, row reordering, and middle-row deletions within the existing log file. It does not detect replacement of the entire DB file with a fresh consistent log. It does not cover direct AgentGate calls outside this repo. There is no repair path: verification reports a broken chain, but does not rebuild or fix it.
- Direct AgentGate calls outside the checkpoint are outside the delegation system's accounting and are not treated as delegated in-scope actions.
- AgentGate remains unchanged. The delegation checkpoint is a sidecar layer in this repo, not a change to AgentGate core semantics.

## Server-Mediated Scope Enforcement

```text
delegate request
  -> checkpoint in this repo
     -> validate + authenticate
     -> enforce delegated scope + local accounting
     -> reserve locally
     -> forward to AgentGate execute
     -> attach returned agentgate_action_id
     -> later resolve through AgentGate
     -> finalize locally

direct AgentGate call
  -> AgentGate only
  -> outside delegation accounting in this repo
```

The checkpoint-managed path also produces an outsider-legible local event trail for the delegation and its checkpoint transitions.

## How It Relates to AgentGate

[AgentGate](https://github.com/selfradiance/agentgate) is the enforcement substrate. This project calls AgentGate's REST API for identity registration, bond management, action execution, and resolution. No changes to AgentGate core were needed — this is a client, not an extension.

AgentGate must be running for this project to work.

## Proof Path

1. `POST /v1/delegations/:id/execute`
   Validates and authenticates the delegated request, enforces local delegated scope including optional declared path/operation constraints, creates a local reservation, starts the forward attempt, performs the real AgentGate execute call, attaches the returned `agentgate_action_id`, and returns either a `forwarded` result or a narrow pre-attachment failure. Existing reservations also re-check parent delegation eligibility and declared payload resource scope before forward/execute preparation.
2. `POST /v1/delegations/:id/actions/:reservationId/finalize`
   Accepts only `success` or `failed`, requires a forwarded and attached checkpoint reservation, resolves through AgentGate, lands in the local finalize seam, and returns either a `finalized` result or a narrow resolution failure. When that finalization resolves the last open checkpoint action on a revoked settling delegation, the delegation now completes through the same local auto-complete path used by normal actions.

## What You Should See

- An in-scope delegated action reaches `stage: "forwarded"` and carries both a local `reservationId` and an attached `agentgateActionId`.
- The explicit finalize step reaches `stage: "finalized"` with `outcome: "success"` or `outcome: "failed"`.
- A disallowed action type is rejected before any AgentGate execute call.
- A declared payload such as `{ "path": "drafts/welcome.md", "operation": "rewrite" }` is accepted when the delegation scope allows prefix `drafts/` and operation `rewrite`.
- Declared payload paths like `.env`, `drafts/../.env`, and `/etc/passwd`, operations like `delete`, or missing constrained fields are rejected before reservation and before any AgentGate execute call.
- An exposure-limit violation is rejected before any AgentGate execute call.
- A pre-attachment AgentGate execute failure returns a machine-readable failure and lands in the local pre-attachment failure seam.
- A reservation whose parent delegation has since been revoked, entered settling, or expired is failed locally with a machine-readable ineligibility reason before more checkpoint forward work happens.
- `status --log` shows the ordered local transparency log for delegation lifecycle events plus checkpoint transitions recorded in this repo.
- `status --log --verify` verifies the local tamper-evident chain for the whole local transparency log, not just the selected delegation's displayed rows, and reports either `ok` or the first broken row.

## v0.5 Resource-Scope Examples

Allowed scope fragment:

```json
{
  "allowed_actions": ["file-transform"],
  "allowed_path_prefixes": ["drafts/"],
  "allowed_operations": ["rewrite"]
}
```

Accepted checkpoint payload:

```json
{ "path": "drafts/welcome.md", "operation": "rewrite" }
```

Rejected checkpoint payloads include:

```json
[
  { "path": ".env", "operation": "rewrite" },
  { "path": "drafts/../.env", "operation": "rewrite" },
  { "path": "/etc/passwd", "operation": "rewrite" },
  { "path": "drafts/welcome.md", "operation": "delete" },
  { "operation": "rewrite" },
  { "path": "drafts/welcome.md" }
]
```

This is local deterministic checkpoint scope admission. It is not general authorization, arbitrary payload semantics, direct-AgentGate blocking, or runtime file/network enforcement.

## Local Transparency Log

Delegation Identity Proof now keeps a local transparency log in repo-local SQLite. It records delegation lifecycle events (`delegation_created`, `delegation_accepted`, `delegation_revoked`, `delegation_closed`) plus checkpoint transitions for checkpoint-managed execution (`delegated_execute_requested`, scope rejection, reservation, forward start, attachment, finalization, and pre-attachment failure).

The local transparency log now has a local tamper-evident hash chain. It is local only. It can detect in-place edits, row reordering, and middle-row deletions within the existing log file. It does not detect replacement of the entire DB file with a fresh consistent log. It does not cover direct AgentGate calls outside this repo. There is no repair path: verification reports a broken chain, but does not rebuild or fix it.

Legacy rows written before this hardening pass remain readable and are reported as unchained rather than broken.

`status --log --verify` verifies the whole local transparency log. The row listing printed by `status --delegation <id> --log` is still just that delegation's rows.

You can inspect it with:

```bash
npx tsx src/cli.ts status --delegation <id> --log
npx tsx src/cli.ts status --delegation <id> --log --verify
```

## What's Implemented

- 6-state machine: pending → accepted → active → settling → completed (+ failed)
- Terminal reason separation: exhausted, closed, revoked, expired
- Two-phase transaction pattern (no SQLite locks across HTTP calls)
- Zod-validated delegation scope with capacity math
- Optional checkpoint resource constraints: `allowed_path_prefixes` and `allowed_operations`
- Dual bond mechanics (human commitment deposit + agent action bond)
- CLI with 7 commands: delegate, accept, act, resolve, revoke, close, status
- `status --log` appends the local transparency-log section for one delegation
- `status --log --verify` verifies the whole local transparency-log chain and reports the first broken row when the chain is no longer consistent
- Ed25519 signed requests for human, agent, and resolver roles
- Bond TTL alignment (human bond = delegation TTL + 1hr margin)
- Auto-complete on scope exhaustion
- Crash recovery for orphaned action reservations
- Checkpoint execute endpoint: `POST /v1/delegations/:id/execute`
- Checkpoint finalize endpoint: `POST /v1/delegations/:id/actions/:reservationId/finalize`
- Real AgentGate execute handoff plus explicit AgentGate resolution bridge for checkpoint-managed actions
- Narrow local seams for reservation, forward start, attachment, pre-attachment failure, and finalization
- Parent-delegation re-checks for pre-attachment checkpoint reservations so revoked / settling / expired parents fail locally instead of continuing forward
- Declared checkpoint `payload.path` / `payload.operation` checks before reservation and before pre-attachment execute handoff
- Local `checkpoint_scope_rejected` event and transparency-log row for authenticated checkpoint resource-scope rejections
- Checkpoint finalization now reuses the existing delegation auto-complete path when the last settling checkpoint action resolves
- Local transparency log for delegation lifecycle events and checkpoint transitions
- Local tamper-evident hash chain for transparency-log rows with no repair command

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
npx tsx src/cli.ts status --delegation <id>

# Check status with transparency log
npx tsx src/cli.ts status --delegation <id> --log

# Verify the local transparency-log chain
npx tsx src/cli.ts status --delegation <id> --log --verify
```

## Non-Goals / Limits

- The checkpoint does not globally block all direct AgentGate calls. Calls made outside it are simply outside delegation accounting in this repo.
- AgentGate does not understand delegation scope. It still sees normal execute and resolve calls.
- No semantic interpretation of arbitrary payloads. v0.5.0 only checks simple declared `payload.path` and `payload.operation` fields when matching constraints exist.
- No runtime file, network, tool, or MCP enforcement beyond this repo's checkpoint admission proof.
- No generic resource policy language, ActionWarrant replacement, or ActionProof replacement.
- No retries, queues, background workers, or broader orchestration.
- No recursive chain-of-custody.
- The transparency log is local and narrow. It does not cover direct AgentGate calls outside the checkpoint.
- The tamper-evident chain does not detect replacement of the entire DB file with a fresh consistent log.
- There is no rebuild, repair, or heal command for a broken chain.
- No generalized authorization framework or UI.
- Human bond remains a commitment deposit rather than a slashable delegation stake.

## Tests

For the v0.5.0 checkpoint resource-scope change, the focused local slices pass:

```bash
npx vitest run test/scope.test.ts
npx vitest run test/delegation.test.ts
npx vitest run test/checkpoint-server.test.ts
npx vitest run test/transparency-log.test.ts test/db.test.ts
npm run typecheck
npm run build
```

`npm test` remains the intended full local suite. In this workspace, the full parallel Vitest run can hit an environment-sensitive AgentGate config collision in `test/delegation.test.ts` (`AGENTGATE_REST_KEY not set`), while that same file passes when run alone. 3 integration tests are opt-in via `RUN_INTEGRATION_TESTS=1` and require live AgentGate.

## Related Projects

- [AgentGate](https://github.com/selfradiance/agentgate) — the core execution engine
- [MCP Firewall](https://github.com/selfradiance/agentgate-mcp-firewall) — governance proxy for MCP tool calls

## Status

v0.1.0 shipped and credible. v0.5.0 keeps the real delegated execution checkpoint path, keeps the local transparency log inspectable through `status --log`, keeps local tamper-evident verification through `status --log --verify`, and adds deterministic checkpoint resource-scope admission for simple declared path/operation payload fields. The claim stays narrow: local checkpoint admission only, no direct-AgentGate blocking, no semantic payload interpretation, and no runtime file/network enforcement.

## Next Narrow Steps

- Surface the persisted local reason for pre-attachment reservation failure through the reservation-status read helpers, not only through the immediate blocking response and transparency row.
- Decide whether the same settling auto-complete hook should also run for every other locally resolved checkpoint failure seam, not just this revocation-propagation/finalization slice.

Design note: [v0.2 server-mediated scope enforcement](docs/v0.2-server-mediated-scope-enforcement.md).

## License

MIT
