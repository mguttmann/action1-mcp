import { describe, expect, it } from "vitest";
import { deriveToolNames, toSnake } from "../../src/codegen/naming.js";

// The codegen's verb-first naming heuristic is the only thing standing
// between Action1's path-shaped operationIds (e.g. `endpoints_managed`)
// and the 134 generated tool names that ship with the package. Silent
// renames here would break agents that hard-code tool names, so pin a
// representative sample of the (method, path) → name mapping.
//
// All cases call `deriveToolNames` with an empty curated-name set so the
// curated-conflict pass is a no-op; the focus is the heuristic itself.

function name(method: string, path: string): string {
  const r = deriveToolNames([{ method, path }], new Set());
  return r[0]!.toolName;
}

describe("toSnake", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnake("orgId")).toBe("org_id");
    expect(toSnake("endpointId")).toBe("endpoint_id");
    expect(toSnake("CamelCaseTest")).toBe("camel_case_test");
  });

  it("converts dashes to underscores", () => {
    expect(toSnake("with-dashes")).toBe("with_dashes");
    expect(toSnake("data-sources")).toBe("data_sources");
  });

  it("collapses consecutive underscores and trims leading/trailing", () => {
    expect(toSnake("__foo__bar__")).toBe("foo_bar");
  });

  it("preserves already-snake_cased input", () => {
    expect(toSnake("already_snake")).toBe("already_snake");
  });
});

describe("deriveToolNames — singletons and read collections", () => {
  it("GET /me → action1_list_me (heuristic; an override re-maps to action1_get_me elsewhere)", () => {
    // Note: `me` operationId gets a curated override to `action1_get_me`
    // in src/codegen/curated-overrides.ts. The pure naming heuristic
    // emits `list_me` (no scope param, no resource id — falls through
    // to CASE 5). Pinning the raw heuristic ensures the override gate
    // is the only thing changing the final name.
    expect(name("GET", "/me")).toBe("action1_list_me");
  });

  it("GET /enterprise → action1_list_enterprises (pluralised)", () => {
    expect(name("GET", "/enterprise")).toBe("action1_list_enterprises");
  });

  it("GET /endpoints/managed/{orgId} → action1_list_endpoints ('managed' is a namespace)", () => {
    expect(name("GET", "/endpoints/managed/{orgId}")).toBe("action1_list_endpoints");
  });

  it("GET /endpoints/groups/{orgId} → action1_list_endpoint_groups (parent qualifier)", () => {
    expect(name("GET", "/endpoints/groups/{orgId}")).toBe(
      "action1_list_endpoint_groups",
    );
  });

  it("GET /vulnerabilities/{orgId} → action1_list_vulnerabilities", () => {
    expect(name("GET", "/vulnerabilities/{orgId}")).toBe(
      "action1_list_vulnerabilities",
    );
  });

  it("GET /audit/events/{orgId} → action1_list_audit_events ('audit' parent qualifies generic 'events')", () => {
    expect(name("GET", "/audit/events/{orgId}")).toBe("action1_list_audit_events");
  });

  it("GET /data-sources/all → action1_list_data_sources ('all' is a namespace)", () => {
    expect(name("GET", "/data-sources/all")).toBe("action1_list_data_sources");
  });

  it("GET /templates/all → action1_list_templates", () => {
    expect(name("GET", "/templates/all")).toBe("action1_list_templates");
  });

  it("GET /reports/all → action1_list_reports", () => {
    expect(name("GET", "/reports/all")).toBe("action1_list_reports");
  });
});

describe("deriveToolNames — single-resource (param-trailing) operations", () => {
  it("GET /endpoints/managed/{orgId}/{endpointId} → action1_get_endpoint", () => {
    expect(name("GET", "/endpoints/managed/{orgId}/{endpointId}")).toBe(
      "action1_get_endpoint",
    );
  });

  it("DELETE /endpoints/managed/{orgId}/{endpointId} → action1_delete_endpoint", () => {
    expect(name("DELETE", "/endpoints/managed/{orgId}/{endpointId}")).toBe(
      "action1_delete_endpoint",
    );
  });

  it("PATCH /endpoints/managed/{orgId}/{endpointId} → action1_update_endpoint", () => {
    expect(name("PATCH", "/endpoints/managed/{orgId}/{endpointId}")).toBe(
      "action1_update_endpoint",
    );
  });

  it("PUT and PATCH both map to update_", () => {
    expect(name("PUT", "/endpoints/managed/{orgId}/{endpointId}")).toBe(
      "action1_update_endpoint",
    );
  });
});

describe("deriveToolNames — POST/destructive write operations", () => {
  it("POST /policies/instances/{orgId} → action1_create_policy_instance", () => {
    expect(name("POST", "/policies/instances/{orgId}")).toBe(
      "action1_create_policy_instance",
    );
  });

  it("POST /automations/instances/{orgId} → action1_create_automation_instance", () => {
    expect(name("POST", "/automations/instances/{orgId}")).toBe(
      "action1_create_automation_instance",
    );
  });

  it("POST /endpoints/groups/{orgId} → action1_create_endpoint_group", () => {
    expect(name("POST", "/endpoints/groups/{orgId}")).toBe(
      "action1_create_endpoint_group",
    );
  });
});

describe("deriveToolNames — action verbs ({id}/move, {id}/requery, ...)", () => {
  it("POST /endpoints/managed/{orgId}/{endpointId}/move → action1_move_endpoint", () => {
    expect(name("POST", "/endpoints/managed/{orgId}/{endpointId}/move")).toBe(
      "action1_move_endpoint",
    );
  });

  it("POST /endpoints/managed/{orgId}/{endpointId}/requery → action1_requery_endpoint", () => {
    expect(name("POST", "/endpoints/managed/{orgId}/{endpointId}/requery")).toBe(
      "action1_requery_endpoint",
    );
  });
});

describe("deriveToolNames — empty / degenerate path", () => {
  it("GET / → action1_list_resources (empty-path fallback)", () => {
    expect(name("GET", "/")).toBe("action1_list_resources");
  });

  it("GET (no leading slash) /me still derives correctly", () => {
    expect(name("GET", "me")).toBe("action1_list_me");
  });
});

describe("deriveToolNames — curated conflict flag", () => {
  it("flags curatedConflict=true when the derived name matches a curated tool", () => {
    const curated = new Set(["action1_list_me"]);
    const r = deriveToolNames([{ method: "GET", path: "/me" }], curated);
    expect(r[0]!.toolName).toBe("action1_list_me");
    expect(r[0]!.curatedConflict).toBe(true);
  });

  it("leaves curatedConflict=false when no overlap with the curated set", () => {
    const r = deriveToolNames(
      [{ method: "GET", path: "/me" }],
      new Set(["action1_something_else"]),
    );
    expect(r[0]!.curatedConflict).toBe(false);
  });
});

describe("deriveToolNames — pass 2 (parent-qualifier disambiguation)", () => {
  it("disambiguates two paths that would collide via parent-qualifier prefix", () => {
    // Both /automations/instances/{}/{automationId} and
    // /automations/schedules/{}/{automationId} would derive to a bare
    // `get_automation` on pass 1 (param-derived resource collapses).
    // Pass 2 re-derives with the parent qualifier prepended.
    const r = deriveToolNames(
      [
        { method: "GET", path: "/automations/instances/{orgId}/{automationId}" },
        { method: "GET", path: "/automations/schedules/{orgId}/{automationId}" },
      ],
      new Set(),
    );
    // The disambiguator picks the second-tier literal ("instances" /
    // "schedules") because the parent literal ("automations") matches
    // the param-derived resource ("automation") — a stutter that pass 2
    // breaks by appending the kind.
    expect(r[0]!.toolName).toBe("action1_get_automation_instance");
    expect(r[1]!.toolName).toBe("action1_get_automation_schedule");
    expect(r[0]!.toolName).not.toBe(r[1]!.toolName);
  });
});

describe("deriveToolNames — pass 3 (method-suffix tiebreaker)", () => {
  it("appends the HTTP method when same-path same-resource ops still collide", () => {
    // POST + PUT to /x/{id}/upload both resolve to `action1_upload_x`
    // on pass 1 *and* pass 2 (no parent-qualifier disambiguation
    // possible — same parent). Pass 3 appends `_post` / `_put`.
    const r = deriveToolNames(
      [
        { method: "POST", path: "/x/{id}/upload" },
        { method: "PUT", path: "/x/{id}/upload" },
      ],
      new Set(),
    );
    expect(r[0]!.toolName).toBe("action1_upload_x_post");
    expect(r[1]!.toolName).toBe("action1_upload_x_put");
  });
});

describe("deriveToolNames — HTTP verb mapping", () => {
  it("GET on a single-resource path → get_", () => {
    expect(name("GET", "/things/{thingId}")).toMatch(/^action1_get_/);
  });

  it("HEAD on a collection path also → list_ (treated like GET)", () => {
    expect(name("HEAD", "/things")).toBe("action1_list_things");
  });

  it("DELETE on a collection → delete_<singular>", () => {
    expect(name("DELETE", "/things")).toBe("action1_delete_thing");
  });
});
