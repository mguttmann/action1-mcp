// Shared, tunable constants, kept in one place so size limits and
// thresholds are not scattered as magic numbers across the codebase.

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
 * Cap on the *items list* portion of a tool response, in UTF-8 bytes.
 * The items appear twice on the wire (`structuredContent` and, in JSON
 * mode, the escaped `content[0].text`), so the whole result is checked
 * separately against `RESPONSE_BYTE_BUDGET`.
 */
export const WIRE_LIMIT_BYTES = 400_000;

/**
 * Budget for one serialised tool result (text block + structuredContent,
 * UTF-8 bytes), enforced centrally in `jsonResult` / `pagedListResult`.
 * Leaves headroom for the JSON-RPC envelope under the 1 MB host limit.
 */
export const RESPONSE_BYTE_BUDGET = 900_000;

/**
 * Default page size for upstream API pagination.
 */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Upper bound of the `limit` input of list tools (curated cursor tools
 * and the generated paging inputs).
 */
export const MAX_LIST_LIMIT = 50_000;

/**
 * Tool name max length per the remote-MCP protocol. Hosts (Claude
 * Desktop, claude.ai) reject names longer than 64 characters.
 */
export const TOOL_NAME_MAX = 64;

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
