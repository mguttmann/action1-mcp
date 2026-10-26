# ADR 0003: Server-side guard for operations that change state

- Status: accepted
- Date: 2026-10-26 (consolidates decisions from 0.2.0 to 0.6.0)

## Context

The tools can run scripts on every managed endpoint, deploy and uninstall
software, reboot machines and change users, roles and organizations. The
model decides which tool to call and with which arguments, and it reads
data (hostnames, script output, audit texts) that third parties can
influence. MCP annotations such as `destructiveHint` are hints to the
host, not enforcement.

## Decision

- Every tool that can change state is guarded in the server:
  - `ACTION1_ALLOW_DESTRUCTIVE` must be on (off by default);
  - account operations (users, roles, `/me`, enterprise, organizations,
    subscription, every non-GET `action1_raw_request`) additionally need
    `ACTION1_ALLOW_ACCOUNT_OPS`;
  - `dry_run` defaults to `true` and returns a preview of the request;
  - `confirm: "YES"` is required unless the operator enables auto-confirm.
- Every generated POST, PUT, PATCH and DELETE operation is guarded. A
  read-only POST can only skip the guard through a reviewed allowlist
  (`READISH_OPERATION_IDS`, empty today); no heuristic on titles.
- The operator can narrow what the model reaches:
  `ACTION1_ALLOWED_ORG_IDS` and `ACTION1_TOOLSETS`.
- Guard decisions are logged (`destructive_dry_run`,
  `destructive_refused`, `destructive_executed`), and the server
  instructions sent to the model are rendered from the same policy.

## Consequences

- `confirm` and `dry_run` protect against model mistakes, not against a
  model that follows injected instructions: the model sets them itself.
  The boundaries that hold are the env switches, the org allowlist, the
  toolset filter, the Action1 role and the host's tool approval. The docs
  say this plainly.
- Previews of some tools need a read-only lookup (for example the
  endpoint's OS), so a preview is not always free of upstream calls.
