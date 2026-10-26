import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fetchSpec from "../../scripts/fetch-spec.mjs";

// Offline tests for the spec extractor (scripts/fetch-spec.mjs). No
// network: the bundle and HTML are synthetic fixtures.

const m = fetchSpec as {
  findIndexAsset: (html: string, base: string) => string;
  extractSpecLiteral: (js: string) => string;
  literalToJson: (literal: string) => string;
  sha256: (text: string) => string;
  diffSummary: (a: unknown, b: unknown) => string;
  undocumentedStatus: (
    spec: unknown,
    entries: { method: string; path: string }[],
  ) => { documented: boolean }[];
};

describe("findIndexAsset", () => {
  it("resolves the Vite entry script against the Swagger UI URL", () => {
    const html =
      '<link rel="modulepreload" href="/apidocs/assets/react-x.js">' +
      '<script type="module" crossorigin src="/apidocs/assets/index-CI0bLlX8.js"></script>';
    expect(m.findIndexAsset(html, "https://app.eu.action1.com/apidocs/")).toBe(
      "https://app.eu.action1.com/apidocs/assets/index-CI0bLlX8.js",
    );
  });

  it("fails loudly when the page layout changed", () => {
    expect(() => m.findIndexAsset("<html></html>", "https://x.test/")).toThrow(/index-\*\.js/);
  });
});

describe("extractSpecLiteral + literalToJson", () => {
  const bundle =
    'const p=1;fetch(e.href,t)}})();const a={openapi:"3.1.0",info:{title:"T",d:"a } brace \\" quote"},' +
    "paths:{\"/x/{orgId}\":{get:{summary:'it\\'s {not} code',description:`multi\nline }`}}}};" +
    "const after={x:1};";

  it("walks braces while skipping string and template contents", () => {
    const lit = m.extractSpecLiteral(bundle);
    expect(lit.startsWith('{openapi:"3.1.0"')).toBe(true);
    expect(lit.endsWith("}}}}")).toBe(true);
  });

  it("evaluates the literal into pretty JSON without a trailing newline", () => {
    const json = m.literalToJson(m.extractSpecLiteral(bundle));
    const spec = JSON.parse(json) as {
      info: { d: string };
      paths: Record<string, { get: { summary: string; description: string } }>;
    };
    expect(spec.info.d).toBe('a } brace " quote');
    expect(spec.paths["/x/{orgId}"]!.get.summary).toBe("it's {not} code");
    expect(spec.paths["/x/{orgId}"]!.get.description).toBe("multi\nline }");
    expect(json).toBe(JSON.stringify(spec, null, 2));
    expect(json.endsWith("\n")).toBe(false);
  });

  it("refuses bundles without the spec or with code inside a template literal", () => {
    expect(() => m.extractSpecLiteral("const a={x:1}")).toThrow(/not found/);
    expect(() => m.extractSpecLiteral('x={openapi:"3.1.0",a:`${evil()}`}')).toThrow(/Template/);
  });

  it("re-serialising the pinned spec reproduces its SHA (format contract)", () => {
    const pinned = readFileSync(
      new URL("../../src/codegen/spec/openapi.json", import.meta.url),
      "utf8",
    );
    const sha = readFileSync(
      new URL("../../src/codegen/spec/openapi.sha256", import.meta.url),
      "utf8",
    ).trim();
    const reserialised = JSON.stringify(JSON.parse(pinned), null, 2);
    expect(m.sha256(reserialised)).toBe(sha);
  });
});

describe("diffSummary and undocumentedStatus", () => {
  const a = {
    paths: { "/a": { get: { operationId: "a" } }, "/b": { post: { operationId: "b" } } },
    components: { schemas: { S: { type: "string" } } },
  };
  const b = {
    paths: {
      "/a": { get: { operationId: "a", summary: "changed" } },
      "/c": { post: { operationId: "c" } },
    },
    components: { schemas: { S: { type: "string" }, T: { type: "object" } } },
  };

  it("lists added, removed and changed operations and schemas", () => {
    const text = m.diffSummary(a, b);
    expect(text).toContain("operations 2 -> 2");
    expect(text).toMatch(/operations added \(1\):\n {2}POST \/c/);
    expect(text).toMatch(/operations removed \(1\):\n {2}POST \/b/);
    expect(text).toMatch(/operations changed \(1\):\n {2}GET \/a/);
    expect(text).toMatch(/schemas added \(1\):\n {2}T/);
  });

  it("reports whether a known-undocumented endpoint appeared in the spec", () => {
    const status = m.undocumentedStatus(b, [
      { method: "POST", path: "/c" },
      { method: "POST", path: "/policies/instances/{orgId}" },
    ]);
    expect(status.map((s) => s.documented)).toEqual([true, false]);
  });
});
