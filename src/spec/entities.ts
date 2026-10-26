// Tolerant readers for the Action1 records the curated tools interpret.
//
// One reader per entity, one place per field. Each reader looks for the
// field the vendored OpenAPI spec documents first (names typed against
// src/spec/generated.ts, so a misspelled or removed spec field is a type
// error) and then for the name the tools assumed before they were bound
// to the spec.
//
// A read-only live check on 2026-10-26 found the spec shape, and none of
// the legacy names, for endpoints, vulnerabilities and their endpoints,
// installed software, automation instances and schedules, missing
// updates, endpoint groups and the list envelopes (TESTING.md, "Live
// shape check 2026-10-26"). Audit events were not verified (the key
// lacked view_audit). The legacy fallbacks stay: each is read after the
// spec field, or on a field the live records do not carry, so none of
// them can mis-read the live shape.
//
// Every spec field and enum value used here is recorded in SPEC_USAGE.
// tests/unit/specContract.test.ts checks each entry against
// components.schemas in openapi.json, so spec drift fails CI.

import {
  SPEC_ENUMS,
  type SpecEntity,
  type SpecEnumName,
  type SpecEnumValue,
  type SpecField,
} from "./generated.js";

export interface SpecUsage {
  kind: "field" | "enum";
  /** Entity name (SPEC_FIELDS key) or enum name (SPEC_ENUMS key). */
  name: string;
  /** Field path below the entity, or the enum value. */
  value: string;
}

const usage: SpecUsage[] = [];

/** Every spec field and enum value the readers rely on. */
export const SPEC_USAGE: readonly SpecUsage[] = usage;

/** A spec field name, checked at compile time and recorded for the contract test. */
function field<E extends SpecEntity>(entity: E, name: SpecField<E>): SpecField<E> {
  usage.push({ kind: "field", name: entity, value: name });
  return name;
}

/** A spec enum value, checked at compile time and recorded for the contract test. */
function enumValue<N extends SpecEnumName>(name: N, value: SpecEnumValue<N>): SpecEnumValue<N> {
  usage.push({ kind: "enum", name, value });
  return value;
}

type Rec = Record<string, unknown>;

export function asRecord(v: unknown): Rec | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** First non-empty string among `keys` (spec name first, then legacy names). */
function firstString(rec: Rec | undefined, keys: readonly string[]): string | undefined {
  if (!rec) return undefined;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Every non-empty string value among `keys`. */
function allStrings(rec: Rec | undefined, keys: readonly string[]): string[] {
  if (!rec) return [];
  const out: string[] = [];
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------
// Result pages

/** Item array of a list response: ResultPage `items`, or a bare array. */
export const RESULT_PAGE_ITEMS = field("ResultPage", "items");

// ---------------------------------------------------------------------
// Automation instances

const STATUS = field("AutomationInstance", "status");

/**
 * Outcome of an automation instance status. The spec enum is
 * Pending|Stopped|Running (automation states) and Success|Warning|Error
 * (instance results). Stopped is final. `Failed` and `Canceled` are the
 * names assumed before the spec binding and are read as failures.
 */
export type AutomationOutcome = "running" | "success" | "warning" | "failure";

const OUTCOMES: readonly [string, AutomationOutcome][] = [
  [enumValue("AutomationInstanceStatus", "Pending"), "running"],
  [enumValue("AutomationInstanceStatus", "Running"), "running"],
  [enumValue("AutomationInstanceStatus", "Success"), "success"],
  [enumValue("AutomationInstanceStatus", "Warning"), "warning"],
  [enumValue("AutomationInstanceStatus", "Error"), "failure"],
  [enumValue("AutomationInstanceStatus", "Stopped"), "failure"],
  ["Failed", "failure"],
  ["Canceled", "failure"],
  ["Cancelled", "failure"],
];

/** The instance status string, if any. */
export function automationStatus(instance: unknown): string | undefined {
  return firstString(asRecord(instance), [STATUS]);
}

/** Outcome of a status value; undefined for an unknown value. */
export function automationOutcome(status: unknown): AutomationOutcome | undefined {
  if (typeof status !== "string") return undefined;
  return OUTCOMES.find(([s]) => eq(s, status))?.[1];
}

/** True when the status is final (anything but Pending / Running / unknown). */
export function isTerminalAutomationStatus(status: unknown): boolean {
  const o = automationOutcome(status);
  return o !== undefined && o !== "running";
}

/** The spec's final statuses, for tool descriptions. */
export const AUTOMATION_TERMINAL_STATUSES: readonly string[] =
  SPEC_ENUMS.AutomationInstanceStatus.filter(isTerminalAutomationStatus);

// ---------------------------------------------------------------------
// Automation schedules

const SCHEDULE_ACTIONS = field("AutomationSchedule", "actions");
const SCHEDULE_TARGETS = field("AutomationSchedule", "endpoints");
const SCHEDULE_SETTINGS = field("AutomationSchedule", "settings");
const ACTION_TEMPLATE_ID = field("AutomationAction", "template_id");
const TARGET_ID = field("AutomationTarget", "id");
const TARGET_TYPE = field("AutomationTarget", "type");

function actionTemplateIds(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((a) => allStrings(asRecord(a), [ACTION_TEMPLATE_ID]));
}

/** Template ids of a schedule's actions. */
export function scheduleTemplateIds(schedule: unknown): string[] {
  return actionTemplateIds(asRecord(schedule)?.[SCHEDULE_ACTIONS]);
}

/** Targets (`{ id, type }`) of a schedule. */
export function scheduleTargets(schedule: unknown): { id: string; type: string | undefined }[] {
  const targets = asRecord(schedule)?.[SCHEDULE_TARGETS];
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((t) => {
    const rec = asRecord(t);
    const id = firstString(rec, [TARGET_ID]);
    return id ? [{ id, type: firstString(rec, [TARGET_TYPE]) }] : [];
  });
}

/**
 * True when a schedule is paused or disabled. The spec carries this in
 * `settings` ("ENABLED MONTHLY:3 AT:17-00-00" / "DISABLED ..."); the
 * shape assumed before had a `status` string.
 */
export function scheduleInactive(schedule: unknown): boolean {
  const s = firstString(asRecord(schedule), ["status", SCHEDULE_SETTINGS]);
  return s !== undefined && /(paused|disabled|stopped)/i.test(s);
}

// ---------------------------------------------------------------------
// Endpoints

const EP_STATUS = field("Endpoint", "status");
const EP_ONLINE_STATUS = field("Endpoint", "online_status");
const EP_PLATFORM = field("Endpoint", "platform");
const EP_OS = field("Endpoint", "OS");
const EP_NAME = field("Endpoint", "name");
const EP_DEVICE_NAME = field("Endpoint", "device_name");
const EP_ADDRESS = field("Endpoint", "address");
const EP_USER = field("Endpoint", "user");

/** The endpoint fields the summary groups by (undefined when absent). */
export function endpointView(endpoint: unknown): {
  status: string | undefined;
  onlineStatus: string | undefined;
  platform: string | undefined;
  os: string | undefined;
} {
  const rec = asRecord(endpoint);
  return {
    status: firstString(rec, [EP_STATUS]),
    onlineStatus: firstString(rec, [EP_ONLINE_STATUS]),
    platform: firstString(rec, [EP_PLATFORM]),
    os: firstString(rec, [EP_OS]),
  };
}

/** Field groups of action1_search_endpoints: spec names first, then assumed names. */
const ENDPOINT_SEARCH_KEYS = {
  hostname: [EP_NAME, EP_DEVICE_NAME, EP_ADDRESS, "hostname", "computer_name"],
  user: [EP_USER, "last_logged_user", "primary_user"],
  os: [EP_OS, EP_PLATFORM, "operating_system"],
  status: [EP_STATUS, EP_ONLINE_STATUS],
} as const;

export type EndpointSearchField = keyof typeof ENDPOINT_SEARCH_KEYS;

/**
 * String values of the chosen field groups (keys matched without regard
 * to case; an object value contributes its `name`).
 */
export function endpointSearchValues(
  endpoint: unknown,
  groups: ReadonlySet<EndpointSearchField>,
): string[] {
  const rec = asRecord(endpoint);
  if (!rec) return [];
  const lookup = new Map<string, unknown>();
  for (const k of Object.keys(rec)) lookup.set(k.toLowerCase(), rec[k]);
  const out: string[] = [];
  for (const group of groups) {
    for (const key of ENDPOINT_SEARCH_KEYS[group]) {
      const v = lookup.get(key.toLowerCase());
      if (typeof v === "string" && v.length > 0) out.push(v);
      else if (group === "os") {
        const name = asRecord(v)?.name;
        if (typeof name === "string") out.push(name);
      }
    }
  }
  return out;
}

const REBOOT_REQUIRED = field("Endpoint", "reboot_required");
const REBOOT_YES = enumValue("EndpointRebootRequired", "Yes");
const REBOOT_NO = enumValue("EndpointRebootRequired", "No");

/** True when the endpoint reports a pending reboot ("Yes"; also "yes" or true). */
export function endpointRebootRequired(endpoint: unknown): boolean {
  const v = asRecord(endpoint)?.[REBOOT_REQUIRED];
  return v === true || (typeof v === "string" && eq(v, REBOOT_YES));
}

/** Map a caller's yes/no (any case) to the spec query value. */
export function rebootRequiredQueryValue(v: string): SpecEnumValue<"EndpointRebootRequired"> {
  return eq(v, REBOOT_YES) ? REBOOT_YES : REBOOT_NO;
}

const RESET_CACHE_YES = enumValue("ResetCache", "Yes");
const RESET_CACHE_NO = enumValue("ResetCache", "No");

/** The spec value of the `reset_cache` query parameter for a boolean input. */
export function resetCacheQueryValue(v: boolean): SpecEnumValue<"ResetCache"> {
  return v ? RESET_CACHE_YES : RESET_CACHE_NO;
}

/** The spec's values of the endpoint list filters, for parameter descriptions. */
export const ENDPOINT_FILTER_VALUES = {
  status: SPEC_ENUMS.EndpointStatus,
  online_status: SPEC_ENUMS.EndpointOnlineStatus,
  update_status: SPEC_ENUMS.EndpointUpdateStatus,
  vulnerability_status: SPEC_ENUMS.EndpointVulnerabilityStatus,
  reboot_required: SPEC_ENUMS.EndpointRebootRequired,
} as const;

// ---------------------------------------------------------------------
// Installed software (ReportData rows)

const SOFTWARE_FIELDS = field("InstalledSoftwareRow", "fields");
const SOFTWARE_NAME = field("InstalledSoftwareFields", "Name");

/** Application name: spec `fields.Name`, else the legacy top-level names. */
export function installedSoftwareName(row: unknown): string | undefined {
  const rec = asRecord(row);
  return (
    firstString(asRecord(rec?.[SOFTWARE_FIELDS]), [SOFTWARE_NAME]) ??
    firstString(rec, ["name", "display_name", "product_name"])
  );
}

// ---------------------------------------------------------------------
// Vulnerabilities

const VULN_ENDPOINT_ID = field("VulnerableEndpoint", "endpoint_id");
const VULN_ENDPOINT_SOFTWARE = field("VulnerableEndpoint", "software");
const VULN_CVE_ID = field("Vulnerability", "cve_id");
const VULN_SOFTWARE = field("Vulnerability", "software");
const SOFTWARE_UPDATES = field("VulnerabilitySoftware", "available_updates");
const UPDATE_PACKAGE_ID = field("VulnerabilityAvailableUpdate", "package_id");
const UPDATE_VERSION = field("VulnerabilityAvailableUpdate", "version");
const MISSING_UPDATE_ID = field("MissingUpdate", "id");

/** Endpoint id of a VulnerableEndpoint row (spec `endpoint_id`, legacy `id`). */
export function vulnerableEndpointId(row: unknown): string | undefined {
  return firstString(asRecord(row), [VULN_ENDPOINT_ID, "id"]);
}

/** CVE id of a Vulnerability row. */
export function vulnerabilityCveId(row: unknown): string | undefined {
  return firstString(asRecord(row), [VULN_CVE_ID]);
}

export interface PackageCandidate {
  id: string;
  version?: string;
}

/**
 * Update packages that fix the vulnerability, from
 * `software[].available_updates[]` of a Vulnerability or VulnerableEndpoint
 * row. Each entry is a `package_id` plus the fixed `version`, the pair
 * action1_deploy_update takes.
 */
export function vulnerabilityPackages(row: unknown): PackageCandidate[] {
  const rec = asRecord(row);
  const software = rec?.[VULN_SOFTWARE] ?? rec?.[VULN_ENDPOINT_SOFTWARE];
  if (!Array.isArray(software)) return [];
  const out: PackageCandidate[] = [];
  for (const s of software) {
    const updates = asRecord(s)?.[SOFTWARE_UPDATES];
    if (!Array.isArray(updates)) continue;
    for (const u of updates) {
      const urec = asRecord(u);
      const id = firstString(urec, [UPDATE_PACKAGE_ID]);
      if (!id) continue;
      const version = firstString(urec, [UPDATE_VERSION]);
      out.push(version !== undefined ? { id, version } : { id });
    }
  }
  return out;
}

/** Package id of a missing-update row. */
export function missingUpdateId(row: unknown): string | undefined {
  return firstString(asRecord(row), [MISSING_UPDATE_ID]);
}

// ---------------------------------------------------------------------
// Audit events

const AUDIT_TIMESTAMP = field("AuditEvent", "timestamp");
const AUDIT_USER = field("AuditEvent", "user_name");
const AUDIT_EVENT = field("AuditEvent", "event");
const AUDIT_OBJECT = field("AuditEvent", "object_name");
const AUDIT_OBJECT_URL = field("AuditEvent", "object_url");
const AUDIT_DESCRIPTION = field("AuditEvent", "description");

/** The spec's audit event names, for parameter descriptions. */
export const AUDIT_EVENT_NAMES = SPEC_ENUMS.AuditEventName;

export interface AuditEventView {
  /** Raw timestamp string (spec `timestamp`, legacy `time`). */
  timestamp: string | undefined;
  /** User names (spec `user_name`, legacy `user`). */
  users: string[];
  /** Event names (spec `event`, legacy `event_type`). */
  events: string[];
  /** Affected object (spec `object_name`, `object_url`, `description`; legacy `target`). */
  targets: string[];
}

export function auditEventView(event: unknown): AuditEventView {
  const rec = asRecord(event);
  return {
    timestamp: firstString(rec, [AUDIT_TIMESTAMP, "time"]),
    users: allStrings(rec, [AUDIT_USER, "user"]),
    events: allStrings(rec, [AUDIT_EVENT, "event_type"]),
    targets: allStrings(rec, [AUDIT_OBJECT, AUDIT_OBJECT_URL, AUDIT_DESCRIPTION, "target"]),
  };
}

// ---------------------------------------------------------------------
// Named objects (endpoint groups, reports) resolved by name

const GROUP_ID = field("EndpointGroup", "id");
const GROUP_NAME = field("EndpointGroup", "name");
const REPORT_ID = field("Report", "id");
const REPORT_NAME = field("Report", "name");

function idAndName(row: unknown, idKey: string, nameKey: string) {
  const rec = asRecord(row);
  const id = firstString(rec, [idKey]);
  const name = firstString(rec, [nameKey]);
  return id !== undefined && name !== undefined ? { id, name } : undefined;
}

/** `{ id, name }` of an endpoint group row, or undefined when either is missing. */
export function endpointGroupRef(row: unknown): { id: string; name: string } | undefined {
  return idAndName(row, GROUP_ID, GROUP_NAME);
}

/** `{ id, name }` of a report row, or undefined when either is missing. */
export function reportRef(row: unknown): { id: string; name: string } | undefined {
  return idAndName(row, REPORT_ID, REPORT_NAME);
}
