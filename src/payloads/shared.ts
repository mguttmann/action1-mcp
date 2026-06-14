/**
 * Shared payload-builder helpers used by both the Windows PowerShell and
 * macOS Bash payload builders. The two prior in-line copies in
 * `windowsPowerShell.ts` and `macOsBash.ts` were identical.
 */

/**
 * Action1 supports two target types when launching policies /
 * automations: a single `Endpoint` or an `EndpointGroup` (server-side
 * fan-out across all members). Both payload builders accept this as
 * an optional input; the curated execution tools expose it as
 * `target_type` for fleetwide actions.
 */
export type TargetType = "Endpoint" | "EndpointGroup";

/**
 * Generate a default action name suffixed with a timestamp so the
 * Action1 console can disambiguate concurrent unnamed actions.
 *
 * Example: `defaultName("PowerShell")` →
 * `"PowerShell_2026-05-04T18-00-00-000Z"`.
 */
export function defaultName(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${label}_${ts}`;
}

/**
 * Convert an Action1 template_id (snake_case) into a human-readable
 * label (Title Case) for the action's display name.
 *
 * Example: `humanize("run_data_collection")` → `"Run Data Collection"`.
 */
export function humanize(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
