import { describe, expect, it } from "vitest";
import {
  buildGroupContentsAdd,
  buildGroupContentsRemove,
} from "../../src/payloads/groupContents.js";

describe("buildGroupContentsAdd", () => {
  it("emits a single-item array: method POST with nested endpoint data", () => {
    expect(buildGroupContentsAdd("ep-1")).toEqual([
      { method: "POST", data: { endpoint_id: "ep-1", type: "Endpoint" } },
    ]);
  });
  it("throws on empty endpointId", () => {
    expect(() => buildGroupContentsAdd("")).toThrow();
  });
});

describe("buildGroupContentsRemove", () => {
  it("emits a single-item array: method DELETE with top-level endpoint_id", () => {
    expect(buildGroupContentsRemove("ep-2")).toEqual([{ method: "DELETE", endpoint_id: "ep-2" }]);
  });
  it("throws on empty endpointId", () => {
    expect(() => buildGroupContentsRemove("")).toThrow();
  });
});
