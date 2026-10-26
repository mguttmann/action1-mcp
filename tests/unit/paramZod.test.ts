import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paramZodSource } from "../../src/codegen/zodEmit.js";
import { SPEC } from "../helpers/specFixtures.js";

// Path and query parameters of generated tools go through the same
// emitter as request bodies, plus the parameter rules in paramZodSource.

describe("paramZodSource", () => {
  it("resolves $ref enums", () => {
    expect(paramZodSource(SPEC, { $ref: "#/components/schemas/RebootRequired" }).zod).toBe(
      'z.enum(["Yes", "No"])',
    );
  });

  it("maps date-time to the Action1 time schema", () => {
    expect(paramZodSource(SPEC, { type: "string", format: "date-time" })).toEqual({
      zod: "action1TimeSchema",
      action1Time: true,
    });
  });

  it("keeps a value composed of several enums a free string", () => {
    expect(paramZodSource(SPEC, { $ref: "#/components/schemas/OS" }).zod).toBe("z.string()");
  });

  it("types numbers, integers, uuids and untyped values", () => {
    expect(paramZodSource(SPEC, { type: "number", minimum: 1 } as never).zod).toBe("z.number()");
    expect(paramZodSource(SPEC, { type: "integer" }).zod).toBe("z.number().int()");
    expect(paramZodSource(SPEC, { type: "string", format: "uuid" }).zod).toBe("z.string().uuid()");
    expect(paramZodSource(SPEC, undefined).zod).toBe("z.string()");
    expect(paramZodSource(SPEC, {}).zod).toBe("z.string()");
  });

  it("the generated tools never use an ISO-only date-time check", () => {
    const src = readFileSync(
      new URL("../../src/tools/generated/index.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\.datetime\(/);
  });
});
