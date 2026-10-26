import { describe, expect, it } from "vitest";
import { inferOutputShape } from "../../src/codegen/outputSchema.js";

// pin the inferOutputShape contract directly so a
// future refactor that inverts the `outputShape !== "single" &&
// outputShape !== "ok_status"` guard (which suppresses pagination
// args on non-JSON exports) gets caught by a unit test instead of
// relying on a Live-Inspector smoke.

const SPEC = {
  paths: {},
  components: {},
};

function listResponse(): Record<string, unknown> {
  return {
    "200": {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { items: { type: "array" } },
          },
        },
      },
    },
  };
}

function singleObjectResponse(): Record<string, unknown> {
  return {
    "200": {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    },
  };
}

function nonJsonResponse(): Record<string, unknown> {
  // Audit-export / report-export style: octet-stream or text/csv, no
  // application/json branch. The codegen must classify these as `single` even when the operation
  // has limit+from pagination args.
  return {
    "200": {
      content: {
        "text/csv": {
          schema: { type: "string" },
        },
        "application/octet-stream": {
          schema: { type: "string" },
        },
      },
    },
  };
}

function noContentResponse(): Record<string, unknown> {
  // 200 without any `content` (think download-stream endpoints).
  return { "200": {} };
}

describe("inferOutputShape", () => {
  it("GET + list-shaped JSON + no pagination → 'list'", () => {
    expect(inferOutputShape(SPEC, listResponse(), "GET", false)).toBe("list");
  });

  it("GET + list-shaped JSON + pagination → 'cursor_list'", () => {
    expect(inferOutputShape(SPEC, listResponse(), "GET", true)).toBe("cursor_list");
  });

  it("GET + single-object JSON + no pagination → 'single'", () => {
    expect(inferOutputShape(SPEC, singleObjectResponse(), "GET", false)).toBe("single");
  });

  it("GET + single-object JSON + pagination → 'cursor_list' (pagination wins)", () => {
    // If pagination is on,
    // the runtime's pagedFetch returns {items,count,...} regardless
    // of what the spec says, so the schema must validate that shape.
    expect(inferOutputShape(SPEC, singleObjectResponse(), "GET", true)).toBe("cursor_list");
  });

  it("POST without spec response → 'ok_status'", () => {
    expect(inferOutputShape(SPEC, undefined, "POST", false)).toBe("ok_status");
  });

  // A non-JSON 200 must short-circuit
  // to `single` (or `ok_status` for mutating methods) BEFORE the
  // pagination-wins rule applies. Otherwise CSV exports would be
  // classified as cursor_list and the runtime's {value: "<csv>"}
  // wrapper would fail schema validation.

  it("GET + non-JSON response + pagination → 'single' (not cursor_list)", () => {
    expect(inferOutputShape(SPEC, nonJsonResponse(), "GET", true)).toBe("single");
  });

  it("GET + non-JSON response + no pagination → 'single'", () => {
    expect(inferOutputShape(SPEC, nonJsonResponse(), "GET", false)).toBe("single");
  });

  it("POST + non-JSON response + pagination → 'ok_status' (mutating fallback)", () => {
    expect(inferOutputShape(SPEC, nonJsonResponse(), "POST", true)).toBe("ok_status");
  });

  it("GET + 200 with no content map at all → 'single' (treated as non-JSON)", () => {
    expect(inferOutputShape(SPEC, noContentResponse(), "GET", true)).toBe("single");
  });
});
