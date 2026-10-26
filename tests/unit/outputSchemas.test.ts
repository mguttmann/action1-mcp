import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  singleObjectOutputShape,
  okStatusOutputShape,
  listOutputShape,
  cursorListOutputShape,
} from "../../src/tools/helpers.js";

// Regression guard: a narrow `singleObjectOutputShape` such as the raw
// shape `{ data: z.record(z.unknown()).optional() }` makes the SDK
// validator reject arbitrary structuredContent (e.g. `{ total,
// by_status, by_platform }`) with "data must NOT have additional
// properties". It must be a permissive ZodObject (.passthrough()).
//
// These tests pin the contract so the bug can't sneak back in.

describe("singleObjectOutputShape", () => {
  it("is a ZodObject (MCP outputSchema must be an object schema)", () => {
    expect(singleObjectOutputShape).toBeInstanceOf(z.ZodObject);
  });

  it("accepts arbitrary properties (passthrough)", () => {
    // Real tool outputs that previously failed.
    const counters = {
      total: 163,
      by_status: { Connected: 15, Disconnected: 148 },
      by_platform: { Windows: 138, Mac: 25 },
      fresh_last_seen: 10,
      stale_last_seen: 153,
      reboot_required: 0,
    };
    expect(() => singleObjectOutputShape.parse(counters)).not.toThrow();
  });

  it("rejects non-objects (still a contract)", () => {
    expect(() => singleObjectOutputShape.parse("string")).toThrow();
    expect(() => singleObjectOutputShape.parse(123)).toThrow();
    expect(() => singleObjectOutputShape.parse([])).toThrow();
  });

  it("accepts the legacy { data: ... } shape too", () => {
    expect(() => singleObjectOutputShape.parse({ data: { foo: "bar" } })).not.toThrow();
  });
});

describe("okStatusOutputShape", () => {
  it("is a ZodObject (MCP outputSchema must be an object schema)", () => {
    expect(okStatusOutputShape).toBeInstanceOf(z.ZodObject);
  });

  it("accepts the destructive-guard dry-run preview shape", () => {
    // `runDestructive` returns this when dry_run=true.
    const dryRunPreview = {
      dry_run: true,
      tool: "action1_run_powershell",
      would_send: {
        method: "POST",
        path: "/policies/instances/org-xxx",
        body: { actions: [{ template_id: "run_powershell" }] },
      },
    };
    expect(() => okStatusOutputShape.parse(dryRunPreview)).not.toThrow();
  });

  it("accepts an arbitrary upstream API live response", () => {
    const liveResponse = {
      id: "instance-yyy",
      status: "started",
      created_at: "2026-01-01T00:00:00Z",
      anything: { else: true },
    };
    expect(() => okStatusOutputShape.parse(liveResponse)).not.toThrow();
  });
});

describe("listOutputShape and cursorListOutputShape", () => {
  // Both are full ZodObjects with .passthrough(), like
  // singleObjectOutputShape.
  it("listOutputShape is a ZodObject (not a raw shape)", () => {
    expect(listOutputShape).toBeInstanceOf(z.ZodObject);
  });

  it("listOutputShape accepts the cappedListResult payload", () => {
    expect(() => listOutputShape.parse({ items: [{ a: 1 }], count: 1, total: 5 })).not.toThrow();
  });

  it("listOutputShape passes through extra upstream-envelope keys", () => {
    // Action1 sometimes emits `next` or other envelope fields. The
    // schema must not reject them - that's what passthrough is for.
    expect(() =>
      listOutputShape.parse({
        items: [{ a: 1 }],
        count: 1,
        next: "some-cursor",
        custom_envelope_field: 42,
      }),
    ).not.toThrow();
  });

  it("listOutputShape still rejects payloads missing `count`", () => {
    // The bug fix is about EXTRA keys, not relaxed required fields.
    // `count` is still required - ensures runtime.ts always emits it.
    expect(() => listOutputShape.parse({ items: [{ a: 1 }] })).toThrow();
  });

  it("cursorListOutputShape is a ZodObject (not a raw shape)", () => {
    expect(cursorListOutputShape).toBeInstanceOf(z.ZodObject);
  });

  it("cursorListOutputShape accepts the pagedListResult payload", () => {
    expect(() =>
      cursorListOutputShape.parse({
        items: [{ a: 1 }],
        count: 1,
        has_more: false,
        next_cursor: null,
        total: 1,
      }),
    ).not.toThrow();
  });

  it("cursorListOutputShape passes through extra envelope keys", () => {
    expect(() =>
      cursorListOutputShape.parse({
        items: [{ a: 1 }],
        count: 1,
        has_more: true,
        next_cursor: "abc",
        upstream_extra: "ok",
      }),
    ).not.toThrow();
  });

  it("cursorListOutputShape accepts the non-cursor envelope (has_more/next_cursor optional)", () => {
    // Generated tools route through runtime.ts's direct path when
    // the caller doesn't pass `cursor` / `auto_paginate`. That path
    // emits {items, count} only - has_more/next_cursor are absent.
    // The schema must tolerate both modes for the same tool.
    expect(() => cursorListOutputShape.parse({ items: [{ a: 1 }], count: 1 })).not.toThrow();
  });
});
