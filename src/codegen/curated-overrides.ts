// Operations the auto-generator should NOT emit, because exposing them as a
// generic CRUD wrapper would either be redundant (handled by the runtime) or
// genuinely unsafe.
//
// Skip is keyed by `operationId` from the OpenAPI spec. Cross-reference:
//   - oauth2_token: handled internally by TokenProvider (refresh_token
//     fallback, proactive 5-min refresh, in-flight dedup). Exposing it as a
//     tool would let an agent bypass that machinery.
//
// `policies_instances_orgId_post` (POST /automations/instances/{orgId}) is NOT
// skipped: the curated execution / workflow tools cover the common cases
// (single-endpoint Win PowerShell, single-endpoint Mac Bash, per-template
// helpers) but the spec also allows multi-action batches, EndpointGroup
// targets, scope=All / MatchingFilters deployments, and library-script
// references. The generated tool exposes the full body so agents can use the
// long-tail variants. Curated tools remain the safer default for the common
// path because they pre-encode the Win `success_exit_codes` requirement and
// the ten-field macOS `run_script` payload.
export const SKIP_OPERATION_IDS = new Set<string>([
  "oauth2_token",
  // Replaced by curated action1_add_endpoint_to_group /
  // action1_remove_endpoint_from_group (src/tools/groups.ts). The generated
  // tool typed the body as z.record (object-only) and could not send the
  // spec's array body, so it could never remove a member.
  "endpoints_groups_groupId_contents_post",
]);

export function isSkipped(operationId: string): boolean {
  return SKIP_OPERATION_IDS.has(operationId);
}

/**
 * Reviewed allowlist of mutating-method (POST) operations that only READ
 * data and therefore get a generated tool WITHOUT the destructive guard.
 *
 * Every POST / PUT / PATCH / DELETE operation that is not listed here is
 * emitted as a destructive tool (confirm + dry_run, destructiveHint).
 * There is deliberately no title-based heuristic ("a POST whose summary
 * starts with get/check/search/... is read-only"): it would silently
 * drop the guard for a future title like "Check and reinstall agents".
 * Adding an entry is a reviewed decision: name the
 * operation, explain why it has no side effect, and keep
 * tests/integration/generatedTools.test.ts green.
 *
 * Keys are operationIds; `assertReadishOperationsMatchSpec` fails the
 * codegen when a key is unknown or not a POST.
 */
export const READISH_OPERATION_IDS: ReadonlySet<string> = new Set<string>([]);

export function assertReadishOperationsMatchSpec(postOperationIds: Set<string>): void {
  const bad = [...READISH_OPERATION_IDS].filter((id) => !postOperationIds.has(id));
  if (bad.length > 0) {
    throw new Error(
      "READISH_OPERATION_IDS entries that are not POST operations in the OpenAPI spec:\n  " +
        bad.join("\n  "),
    );
  }
}

/**
 * Hand-picked tool-name overrides for operations whose default
 * verb-first heuristic produces an awkward or colliding name.
 *
 * Map keyed by operationId (from the OpenAPI spec). The value replaces
 * whatever the naming heuristic emits - including the `action1_` prefix.
 *
 * Used for two cases:
 *   1. Heuristic chose a misleading name (e.g. `action1_create_endpoint`
 *      for the "requery installed software" action).
 *   2. Heuristic name collides with a curated tool that handles a
 *      *different* sub-resource, and disambiguating via parent qualifier
 *      is the right semantic split.
 */
// IMPORTANT: every key MUST match a real `operationId` from the
// pinned OpenAPI spec. The codegen runs `assertNameOverridesMatchSpec`
// at codegen-time and hard-fails if any key here is unknown - that
// catches typos and stale spec-drift before they ship as silently-
// dead code.
//
// The Action1 spec uses some non-obvious operationId conventions:
//   - GET /me                             → operationId `me`
//   - GET /enterprise                     → `enterprise_get`
//   - GET /search/{orgId}                 → `search` (no `_get` suffix)
//   - GET /endpoints/status/{orgId}       → `endpoints_status`
//   - GET /endpoints/agent-installation/{orgId}/{installType}
//                                         → `endpoints_agent_installation`
//   - GET /subscription/enterprise        → `license_enterprise_get`
//                                           (not `subscription_*`!)
//   - GET /subscription/usage/enterprise  → `license_usage_enterprise_get`
//   - GET /subscription/usage/organizations/{orgId}
//                                         → `license_usage_organizations_orgId_get`
//   - POST /installed-software/{orgId}/requery/{endpointId}
//                                         → `apps_orgId_requery_endpointId_post`
//                                           (yes - the spec mis-names this
//                                            after `apps`, not `installed-software`)
//
// Always `grep '"operationId"' src/codegen/spec/openapi.json` before
// adding a new override.
export const NAME_OVERRIDES: Record<string, string> = {
  // GET /vulnerabilities/{orgId} - org-wide CVE rollup with 13 server-side
  // filter params. Without this override the naming heuristic emits
  // `action1_list_vulnerabilities`, which collides with the curated
  // `action1_list_vulnerabilities` (per-endpoint).
  vulnerabilities_orgId_get: "action1_list_org_vulnerabilities",

  // POST /installed-software/{orgId}/requery/{endpointId} - kicks off a
  // refresh of the installed-software inventory. Default heuristic
  // emitted `action1_create_endpoint`, which is downright dangerous
  // (sounds like "create new endpoint"). Spec quirks: this operation is
  // labelled `apps_*` even though the path is `/installed-software/`.
  apps_orgId_requery_endpointId_post: "action1_requery_installed_software_for_endpoint",

  // POST /installed-software/{orgId}/requery - org-wide variant of the
  // above. Same naming logic.
  apps_orgId_requery_post: "action1_requery_installed_software_for_org",

  // GET /endpoints/agent-installation/{orgId}/{installType} - returns the
  // download URL for a chosen installer type. Heuristic emits
  // `action1_get_install_type` which sounds like "ask Action1 which type
  // is installed". Real intent: fetch URL by chosen type.
  endpoints_agent_installation: "action1_get_agent_install_url",

  // GET /endpoints/connector-installation/{orgId}/windowsEXE - returns the
  // single Windows-EXE deployer URL. Heuristic emits
  // `action1_list_windows_exes` (plural list). Real intent: get the
  // single EXE URL.
  endpoints_connector_installation_orgId_windowsEXE_get: "action1_get_windows_deployer_url",

  // GET /search/{orgId} - universal-search facade. Default heuristic
  // emits `action1_list_search` (tautology). Use a clean verb form.
  search: "action1_search",

  // GET /endpoints/status/{orgId} - returns a single boolean indicator
  // ("any endpoints onboarded yet"). `action1_list_endpoint_status` is
  // misleading since the response is an object, not a list.
  endpoints_status: "action1_get_endpoints_onboarded_status",

  // GET /audit/export - single export blob, not a list of exports.
  audit_export_get: "action1_export_audit_log",

  // GET /me - single record. `action1_list_me` is nonsense for a
  // singleton resource.
  me: "action1_get_me",

  // GET /enterprise - single record. `action1_list_enterprises` (plural)
  // is misleading; the API returns the *current* enterprise's data.
  enterprise_get: "action1_get_enterprise",

  // GET /subscription/enterprise - single subscription record for the
  // current enterprise. (Spec calls it `license_*` not `subscription_*`!)
  license_enterprise_get: "action1_get_subscription",

  // GET /subscription/usage/enterprise - single usage record for the
  // current enterprise.
  license_usage_enterprise_get: "action1_get_subscription_usage",

  // GET /subscription/usage/organizations/{orgId} - single org-level
  // usage record.
  license_usage_organizations_orgId_get: "action1_get_org_subscription_usage",

  // GET /endpoints/discovery/{orgId} - single discovery configuration
  // object, not a list of deployments.
  endpoints_discovery_orgId_get: "action1_get_endpoint_discovery_settings",

  // POST /software-repository/{orgId} - heuristic emits
  // `action1_create_software_repository`, but the real action creates
  // a *package* inside the repository, not the repository itself.
  packages_all_post: "action1_create_package",

  // POST /subscription/enterprise/trial - operationId is
  // `license_enterprise_trial_post` (spec quirk). Heuristic name
  // `action1_create_subscription_trial` is misleading because no
  // subscription / trial object is created - it's a *request* to
  // Action1 sales for a trial extension.
  license_enterprise_trial_post: "action1_request_enterprise_trial",

  // POST /subscription/enterprise/quote - analog to the trial-request:
  // sends a sales-quote request, doesn't create a quote object.
  license_enterprise_quote_post: "action1_request_enterprise_quote",

  // POST /enterprise/request-closure - heuristic produces the
  // double-verb `action1_create_enterprise_request_closure`. Real
  // intent: request that the enterprise be closed.
  enterprise_request_closure: "action1_request_enterprise_closure",

  // POST /enterprise/revoke-closure - same pattern: revokes a previously
  // requested closure.
  enterprise_revoke_closure: "action1_revoke_enterprise_closure",

  // GET /audit/events/{id} - heuristic emits the unhelpfully generic
  // `action1_get_event`. Real domain: audit log.
  audit_events_id_get: "action1_get_audit_event",

  // GET /automations/instances/{orgId}/{instanceId}/endpoint-results/
  //   {endpointId}/details - heuristic emits `action1_list_endpoint_details`,
  // which sounds like "list endpoint inventory details" (the
  // endpoint-management resource). The real semantics: fetch the
  // automation-script *output* (stdout/stderr/exit_code) recorded
  // against one endpoint inside one automation instance. Rename to
  // make that domain unambiguous.
  policies_instances_orgId_instanceId_endpoint_results_endpointId_details_get:
    "action1_get_automation_script_output",

  // DELETE /automations/schedules/{orgId}/{automationId}/actions/{actionId}
  // - deletes a single action *from an automation schedule*. Default
  // heuristic emits the bare `action1_delete_action`, which collides
  // semantically with `delete_additional_action` (a sibling delete on
  // a package). Qualify with the parent resource (`automation`) so
  // the agent picks the right verb.
  policies_schedules_orgId_automationId_actions_actionId_delete: "action1_delete_automation_action",

  // DELETE /software-repository/{orgId}/{packageId}/versions/{versionId}
  //   /additional-actions/{actionId} - deletes a pre/post-install action
  // attached to a *package version*. Heuristic emits
  // `action1_delete_additional_action` which gives the agent no hint
  // about whose action it deletes. Rename to anchor on the package
  // domain so it stops competing with `delete_automation_action`.
  packages_all_packageId_versions_versionId_additional_actions_actionId_delete:
    "action1_delete_package_version_action",

  // POST /software-repository/{orgId}/{packageId}/versions/{versionId}/upload
  // INIT step of a chunked upload. Both upload operations need request
  // headers (and the PUT a binary body) that the generated runtime does
  // not send, so the codegen emits them as "unsupported" tools that
  // explain this instead of calling Action1 (see unsupportedReason in
  // generate.ts). Default heuristic emits the method-suffix tiebreaker
  // `action1_upload_software_repository_version_post`, which is
  // unintelligible. Rename to express semantics.
  packages_all_packageId_versions_versionId_upload_post: "action1_init_software_upload",

  // PUT /software-repository/{orgId}/{packageId}/versions/{versionId}/upload
  // - uploads one CHUNK using the upload_id from the POST init call.
  // Same naming rationale as the POST variant: method-suffix tiebreaker
  // is unreadable.
  packages_all_packageId_versions_versionId_upload_put: "action1_upload_software_chunk",
};

export function nameOverrideFor(operationId: string): string | undefined {
  return NAME_OVERRIDES[operationId];
}

/**
 * Optional lead-text prefixed to the generated tool description.
 *
 * Used to disambiguate generated tools that overlap with a curated tool's
 * domain. The curated tool stays the simpler default; the generated
 * variant gets a "Filtered/paginated variant of <curated>." hint so the
 * agent picks it only when the extra filter/sort/pagination knobs are
 * actually needed.
 *
 * Keys are operationIds from the OpenAPI spec - same validation strategy
 * as NAME_OVERRIDES (the codegen runs `assertDescriptionHintsMatchSpec`
 * to catch typos before they ship as silently-dead overrides).
 */
export const OPERATION_DESCRIPTION_HINTS: Record<string, string> = {
  // GET /endpoints/managed/{orgId}/{endpointId}/missing-updates - the
  // curated `action1_list_missing_updates` covers the common case; this
  // generated variant adds server-side filter/sortby/security_severity/
  // approval_status knobs and pagination. Point the agent at the
  // curated default but document the upgrade path.
  endpoints_managed_endpointId_missing_updates:
    "Filtered/paginated variant of action1_list_missing_updates (curated). " +
    "Use for severity/approval_status/sortby filtering.",

  // GET /automations/instances/{}/.../endpoint-results/{ep}/details -
  // exposes the raw automation-action output struct. Curated
  // action1_get_automation_output is the friendlier sibling (returns
  // filtered stdout with status markers stripped). Cross-reference so
  // the agent picks the right one.
  policies_instances_orgId_instanceId_endpoint_results_endpointId_details_get:
    "Raw automation-script output struct. For filtered stdout (status " +
    "markers stripped) prefer action1_get_automation_output (curated).",

  // GET /vulnerabilities/{orgId} - renamed to action1_list_org_vulnerabilities
  // (org-wide CVE rollup). Coexists with curated
  // action1_list_vulnerabilities (per-endpoint). Cross-reference so
  // the agent picks the right scope.
  vulnerabilities_orgId_get:
    "Org-wide CVE rollup with 13 server-side filters. For per-endpoint " +
    "vulnerabilities use action1_list_vulnerabilities (curated).",
};

export function descriptionHintFor(operationId: string): string | undefined {
  return OPERATION_DESCRIPTION_HINTS[operationId];
}

/**
 * Codegen-time assertion mirror of `assertNameOverridesMatchSpec`. Catches
 * stale `OPERATION_DESCRIPTION_HINTS` keys before they ship.
 */
export function assertDescriptionHintsMatchSpec(allOperationIds: Set<string>): void {
  const stale: string[] = [];
  for (const key of Object.keys(OPERATION_DESCRIPTION_HINTS)) {
    if (!allOperationIds.has(key)) stale.push(key);
  }
  if (stale.length > 0) {
    throw new Error(
      "Stale OPERATION_DESCRIPTION_HINTS keys (no matching operationId in OpenAPI spec):\n  " +
        stale.join("\n  ") +
        "\nFix the keys to match real operationIds, or remove the overrides.",
    );
  }
}

/**
 * Codegen-time assertion: every NAME_OVERRIDES key MUST exist as an
 * `operationId` in the OpenAPI spec. Catches typos and spec-drift
 * before we ship dead-code overrides that silently let the heuristic
 * pick a misleading name.
 */
export function assertNameOverridesMatchSpec(allOperationIds: Set<string>): void {
  const stale: string[] = [];
  for (const key of Object.keys(NAME_OVERRIDES)) {
    if (!allOperationIds.has(key)) stale.push(key);
  }
  if (stale.length > 0) {
    throw new Error(
      "Stale NAME_OVERRIDES keys (no matching operationId in OpenAPI spec):\n  " +
        stale.join("\n  ") +
        "\nFix the keys to match real operationIds, or remove the overrides.",
    );
  }
}
