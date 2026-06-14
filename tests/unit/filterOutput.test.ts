import { describe, expect, it } from "vitest";
import { filterEndpointResultDetails, isStatusMarker } from "../../src/utils/filterOutput.js";

describe("filterEndpointResultDetails", () => {
  it("strips Starting/Waiting/Completed status markers in the canonical Action1 form", () => {
    const result = filterEndpointResultDetails([
      { description: "Starting" },
      { description: "Waiting: queued" },
      { description: "hello world" },
      { description: "second line" },
      { description: "Completed: 5 of 5" },
    ]);
    expect(result.output).toBe("hello world\nsecond line");
    expect(result.skippedStatusLines).toBe(3);
    expect(result.rawDescriptions).toHaveLength(5);
  });

  it("returns empty output when only status markers are present", () => {
    const result = filterEndpointResultDetails([
      { description: "Starting" },
      { description: "Completed" },
    ]);
    expect(result.output).toBe("");
    expect(result.skippedStatusLines).toBe(2);
  });

  it("handles non-array input gracefully", () => {
    expect(filterEndpointResultDetails(null).output).toBe("");
    expect(filterEndpointResultDetails(undefined).output).toBe("");
    expect(filterEndpointResultDetails({}).output).toBe("");
  });

  it("ignores items without a string description", () => {
    const result = filterEndpointResultDetails([
      { description: 42 },
      { description: "real" },
      { foo: "bar" },
    ]);
    expect(result.output).toBe("real");
  });

  // Anchor-match regression suite (new in this pass):
  // The previous substring match dropped legitimate output lines that
  // merely contained "Starting"/"Waiting"/"Completed" anywhere. The
  // anchored regex keeps them.
  it("keeps a real script line that merely contains 'Completed' (anchor-match)", () => {
    // (a) Real script output like "Completed CVE remediation: 3 packages"
    //     is kept — the marker is not at line start, it's followed by
    //     more content with a non-colon character.
    const result = filterEndpointResultDetails([
      { description: "Completed CVE remediation: 3 packages" },
    ]);
    expect(result.output).toBe("Completed CVE remediation: 3 packages");
    expect(result.skippedStatusLines).toBe(0);
  });

  it("drops a canonical 'Completed: <details>' status line", () => {
    // (b) Action1 emits its terminal marker as "Completed: <summary>".
    //     The strict regex catches it.
    const result = filterEndpointResultDetails([
      { description: "Completed: 5 of 5" },
    ]);
    expect(result.output).toBe("");
    expect(result.skippedStatusLines).toBe(1);
  });

  it("drops 'Waiting: queued' but keeps 'Waiting for kernel symbols'", () => {
    // (c) "Waiting:" is a status marker. "Waiting for kernel symbols"
    //     is a legit diagnostic line that happens to start with the
    //     same word but is not followed by a colon — kept.
    const result = filterEndpointResultDetails([
      { description: "Waiting: queued" },
      { description: "Waiting for kernel symbols" },
    ]);
    expect(result.output).toBe("Waiting for kernel symbols");
    expect(result.skippedStatusLines).toBe(1);
  });
});

describe("isStatusMarker", () => {
  it("matches the canonical 'Marker:' and bare marker forms only", () => {
    expect(isStatusMarker("Starting")).toBe(true);
    expect(isStatusMarker("Completed: ok")).toBe(true);
    expect(isStatusMarker("Waiting: queued")).toBe(true);
    // False-positives the old substring match would have triggered:
    expect(isStatusMarker("Some Waiting period")).toBe(false);
    expect(isStatusMarker("Completed CVE remediation")).toBe(false);
    expect(isStatusMarker("Waiting for kernel symbols")).toBe(false);
    expect(isStatusMarker("plain output")).toBe(false);
  });
});
