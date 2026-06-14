// Shared, tunable constants. The skill best-practice (`node_mcp_server.md`)
// asks for a per-project CHARACTER_LIMIT constant; everything else lives
// here so we don't have to chase magic numbers across the codebase.

/**
 * Soft cap on the *human-readable* output (Markdown text) of a single
 * tool call. Set conservatively so a typical 200-row table fits well
 * under the 1 MB host limit AND under the model's context budget for
 * follow-on operations.
 *
 * Tools that exceed this should truncate and append a clear note
 * explaining how to refine the query.
 */
export const CHARACTER_LIMIT = 25_000;

/**
 * Hard cap on the *items list* portion of a tool response, in bytes.
 * Sized so that with the parallel `structuredContent` block plus the
 * JSON-RPC envelope, we stay safely under the 1 MB MCP host wire limit.
 *
 *   400 KB items
 *     + 400 KB text (escaped, slightly bigger)
 *     + ~50 KB JSON-RPC envelope, headers, content[0] wrapper
 *   ≈ 850 KB on the wire — comfortably under 1 MB.
 */
export const WIRE_LIMIT_BYTES = 400_000;

/**
 * Default page size for upstream API pagination.
 */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Tool name max length per the remote-MCP protocol. Hosts (Claude
 * Desktop, claude.ai) reject names longer than 64 characters.
 */
export const TOOL_NAME_MAX = 64;

/**
 * `last_seen` freshness threshold (seconds). Action1 reports
 * `status: "Connected"` even when last_seen is hours old; we
 * additionally require last_seen within this window to consider an
 * endpoint truly online.
 */
export const LAST_SEEN_FRESH_SECONDS = 600;

/**
 * Default polling interval (ms) for `wait_for_automation` and friends.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Per-string ceiling for the generic compactor in `src/utils/capOutput.ts`.
 *
 * Action1 occasionally embeds full PowerShell scripts, hundred-CVE
 * comma lists, and EULA text inside list-shaped responses; a single
 * one of those can blow past 5 KB and starve the host context after
 * one or two calls. The compactor truncates strings longer than this
 * and replaces nested objects holding embedded code with a stable
 * placeholder. Sized so a typical script preview (~400 chars) is
 * still useful but a 10 KB EULA wall doesn't poison every list call.
 */
export const COMPACT_STRING_CEILING = 400;

/**
 * Default polling timeout (ms) — 5 minutes. Cap below 1 hour to avoid
 * pathological runaway loops.
 */
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000;
