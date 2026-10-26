import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  classifyOperation,
  curatedSourceFiles,
  normalizeTitle,
  unsupportedReason,
} from "../../src/codegen/generate.js";
import { READISH_OPERATION_IDS } from "../../src/codegen/curated-overrides.js";
import { GENERATED_TOOL_MANIFEST } from "../../src/tools/generated/index.js";
import {
  bodyZodSource,
  outputObjectSource,
  responseProperties,
  type JsonSchema,
} from "../../src/codegen/zodEmit.js";

// Unit tests for the generator building blocks. Generated-artifact
// invariants (every mutating operation is guarded, the guard sweep, real
// bodies over MCP) live in tests/integration/generatedTools.test.ts.

/** Evaluate emitted Zod source the same way the generated file does. */
// Input is emitter output for the fixture schemas above, never external data.
function compile(source: string): z.ZodType {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return (new Function("z", "return " + source) as (zod: typeof z) => z.ZodType)(z);
}

const spec = {
  components: {
    schemas: {
      Pkg: {
        type: "object",
        properties: { id: { type: "string" }, ver: { type: "string" } },
        required: ["id"],
      },
      Base: {
        properties: {
          name: { type: "string", description: "The name." },
          kind: { type: "string" },
        },
        required: ["name"],
      },
      Post: { allOf: [{ $ref: "#/components/schemas/Base" }], required: ["kind"] },
      Loop: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Loop" } },
      },
    },
  },
};

describe("classifyOperation (destructive classification)", () => {
  it("GET and HEAD are read-only", () => {
    expect(classifyOperation("GET", "x")).toEqual({ isReadOnly: true, isDestructive: false });
    expect(classifyOperation("HEAD", "x")).toEqual({ isReadOnly: true, isDestructive: false });
  });

  it("every other method is destructive by default", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(classifyOperation(m, "anything").isDestructive, m).toBe(true);
    }
  });

  it("does not look at titles: read-verb operationIds stay destructive (former heuristic gap)", () => {
    // The removed title-prefix heuristic would have treated a POST titled
    // "Check and reinstall agents" or "Get a new token" as read-only.
    for (const id of ["check_and_reinstall", "get_new_token", "search_and_delete", "list_wipe"]) {
      expect(classifyOperation("POST", id).isDestructive, id).toBe(true);
    }
  });

  it("the read-ish allowlist only applies to POST", () => {
    for (const id of READISH_OPERATION_IDS) {
      expect(classifyOperation("POST", id).isDestructive).toBe(false);
      expect(classifyOperation("DELETE", id).isDestructive).toBe(true);
    }
  });

  it("the read-ish allowlist is empty today (every Action1 POST mutates)", () => {
    expect([...READISH_OPERATION_IDS]).toEqual([]);
  });
});

describe("normalizeTitle", () => {
  it("turns a leading gerund into the imperative", () => {
    expect(normalizeTitle("Listing roles")).toBe("List roles");
    expect(normalizeTitle("Getting a specific role")).toBe("Get a specific role");
    expect(normalizeTitle("Searching")).toBe("Search");
  });

  it("drops the vendor's TBD: prefix and a trailing period", () => {
    expect(normalizeTitle("TBD:Manage updates approvals")).toBe("Manage updates approvals");
    expect(normalizeTitle("Listing report subscriptions.")).toBe("List report subscriptions");
  });

  it("leaves imperative titles and unknown words alone", () => {
    expect(normalizeTitle("Get user")).toBe("Get user");
    expect(normalizeTitle("Detailed information on a CVE")).toBe("Detailed information on a CVE");
  });
});

describe("unsupportedReason", () => {
  it("flags a binary request body and required headers", () => {
    const r = unsupportedReason("t", ["application/octet-stream"], ["Content-Range"]);
    expect(r).toMatch(/application\/octet-stream/);
    expect(r).toMatch(/Content-Range/);
  });

  it("accepts JSON bodies without headers", () => {
    expect(unsupportedReason("t", ["application/json"], [])).toBeNull();
    expect(unsupportedReason("t", [], [])).toBeNull();
  });
});

describe("bodyZodSource", () => {
  it("emits a top-level array body with typed items", () => {
    const schema: JsonSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["New", "Approved"] },
          packages: { type: "array", items: { $ref: "#/components/schemas/Pkg" } },
        },
        required: ["status"],
      },
    };
    const zs = compile(bodyZodSource(spec, schema, "POST"));
    expect(zs.safeParse([{ status: "New", packages: [{ id: "a" }] }]).success).toBe(true);
    expect(zs.safeParse({ status: "New" }).success).toBe(false);
    expect(zs.safeParse([{ status: "Maybe" }]).success).toBe(false);
    expect(zs.safeParse([{ packages: [] }]).success).toBe(false);
  });

  it("merges allOf and enforces required on POST but not on PATCH", () => {
    const schema: JsonSchema = { $ref: "#/components/schemas/Post" };
    const post = compile(bodyZodSource(spec, schema, "POST"));
    expect(post.safeParse({ name: "n", kind: "k" }).success).toBe(true);
    expect(post.safeParse({ name: "n" }).success).toBe(false);
    const patch = compile(bodyZodSource(spec, schema, "PATCH"));
    expect(patch.safeParse({}).success).toBe(true);
  });

  it("lets unknown keys pass through", () => {
    const zs = compile(bodyZodSource(spec, { $ref: "#/components/schemas/Pkg" }, "POST"));
    expect(zs.parse({ id: "a", extra: 1 })).toEqual({ id: "a", extra: 1 });
  });

  it("translates oneOf into a union and const into a literal", () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: "object", properties: { t: { const: "A" } }, required: ["t"] },
        {
          type: "object",
          properties: { t: { const: "B" }, b: { type: "integer" } },
          required: ["t", "b"],
        },
      ],
    };
    const zs = compile(bodyZodSource(spec, schema, "POST"));
    expect(zs.safeParse({ t: "A" }).success).toBe(true);
    expect(zs.safeParse({ t: "B", b: 2 }).success).toBe(true);
    expect(zs.safeParse({ t: "C" }).success).toBe(false);
  });

  it("treats a string enum with {placeholder} values as a free-form string, not as options", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { object: { type: "string", enum: ["all", "{orgId}", "{groupId}"] } },
    };
    const src = bodyZodSource(spec, schema, "POST");
    expect(src).not.toContain("z.enum(");
    const zs = compile(src);
    expect(zs.safeParse({ object: "abcdef12-0000-0000-0000-000000000009" }).success).toBe(true);
    expect(zs.safeParse({ object: "all" }).success).toBe(true);
    expect(zs.safeParse({ object: 1 }).success).toBe(false);
  });

  it("keeps a plain string enum strict", () => {
    const zs = compile(bodyZodSource(spec, { type: "string", enum: ["a", "b"] }, "POST"));
    expect(zs.safeParse("a").success).toBe(true);
    expect(zs.safeParse("c").success).toBe(false);
  });

  it("survives recursive $refs", () => {
    const src = bodyZodSource(spec, { $ref: "#/components/schemas/Loop" }, "POST");
    expect(() => compile(src)).not.toThrow();
  });

  it("maps pattern-keyed objects to records and nullable types to .nullable()", () => {
    const zs = compile(
      bodyZodSource(
        spec,
        {
          type: "object",
          properties: {
            map: { type: "object", patternProperties: { "^.*$": { type: "string" } } },
            maybe: { type: ["string", "null"] },
          },
        },
        "POST",
      ),
    );
    expect(zs.safeParse({ map: { a: "1" }, maybe: null }).success).toBe(true);
    expect(zs.safeParse({ map: { a: 1 } }).success).toBe(false);
  });
});

describe("output schema helpers", () => {
  it("responseProperties merges allOf", () => {
    const props = responseProperties(spec, { $ref: "#/components/schemas/Post" });
    expect(Object.keys(props ?? {})).toEqual(["name", "kind"]);
  });

  it("outputObjectSource never rejects an object, whatever the value types", () => {
    const zs = compile(outputObjectSource({ id: { type: "string" }, count: { type: "integer" } }));
    expect(zs.safeParse({ id: 5, count: null, extra: [1] }).success).toBe(true);
    expect(zs.safeParse({}).success).toBe(true);
  });
});

describe("curated tool discovery", () => {
  it("scans every curated source file under src/tools, including raw.ts, and skips generated/", () => {
    const files = curatedSourceFiles().map((f) => f.replace(/\\/g, "/"));
    expect(files.some((f) => f.endsWith("/src/tools/raw.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/src/tools/wrappers/index.ts"))).toBe(true);
    expect(files.some((f) => f.includes("/src/tools/generated/"))).toBe(false);
  });
});

describe("generated tool naming rule", () => {
  // Generated names are verb-first: action1_<verb>_<resource>. Existing
  // names are frozen for compatibility (tests/fixtures/tools-list.baseline.json);
  // this rule keeps NEW generated names on the same scheme.
  const VERBS = new Set([
    "get",
    "list",
    "create",
    "update",
    "delete",
    "search",
    "clone",
    "export",
    "init",
    "move",
    "requery",
    "request",
    "revoke",
    "stop",
    "upload",
  ]);

  it("every generated tool name starts with a known verb", () => {
    const names = GENERATED_TOOL_MANIFEST.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    const offenders = names.filter((n) => !VERBS.has(n.split("_")[1]!));
    expect(offenders).toEqual([]);
  });
});
