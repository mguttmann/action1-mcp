import { afterEach, describe, expect, it, vi } from "vitest";
import { runGenerated } from "../../src/tools/generated/runtime.js";
import type { Action1Client } from "../../src/client/action1Client.js";

function fakeClient(impl: {
  request?: (path: string, opts: unknown) => Promise<unknown>;
  paginate?: (path: string, opts: unknown) => AsyncGenerator<unknown, void, void>;
}): Action1Client {
  return {
    request: impl.request ?? (() => Promise.resolve({ ok: true })),
    paginate:
      impl.paginate ??
      async function* () {
        return;
      },
  } as unknown as Action1Client;
}

describe("runGenerated", () => {
  // Previously a stray `vi.restoreAllMocks();` sat at the bottom of the
  // `toQueryValue` describe block (in the describe-body, not an after-hook).
  // It ran exactly once at file-load and reset nothing between tests, which
  // would silently leak mock state into adjacent suites. Hoist the cleanup
  // into a proper `afterEach` so mocks are torn down per-test for both
  // describe blocks in this file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards method/path/body/query and surfaces structuredContent", async () => {
    const seen: { path?: string; opts?: unknown } = {};
    const client = fakeClient({
      request: (path, opts) => {
        seen.path = path;
        seen.opts = opts;
        return Promise.resolve({ id: "x", name: "y" });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/foo/bar",
      queryParams: { limit: 5, sort: "asc", noop: undefined },
    });
    expect(r.isError).toBeFalsy();
    expect(seen.path).toBe("/foo/bar");
    expect((seen.opts as { method: string }).method).toBe("GET");
    expect((seen.opts as { query: Record<string, unknown> }).query).toEqual({
      limit: 5,
      sort: "asc",
    });
    expect(r.structuredContent).toEqual({ id: "x", name: "y" });
  });

  it("auto_paginate honours caller limit as maxItems", async () => {
    let calls = 0;
    const client = fakeClient({
      request: () => {
        calls += 1;
        // Pretend the upstream has lots of pages, page size 200
        const page = Array.from({ length: 200 }, (_, i) => ({ idx: calls * 200 + i }));
        return Promise.resolve({ items: page });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      queryParams: { limit: 7 },
      autoPaginate: true,
    });
    // pagedFetch should stop after returning 7 items
    expect((r.structuredContent as { count: number }).count).toBe(7);
  });

  it("caps a paginated list at limit without a cursor when the upstream returns more", async () => {
    const client = fakeClient({
      request: () =>
        Promise.resolve({ items: Array.from({ length: 10 }, (_, i) => ({ i })), total_items: 10 }),
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      queryParams: { limit: 3, from: 0 },
      paginated: true,
      responseFormat: "json",
    });
    const s = r.structuredContent as { items: unknown[]; count: number; has_more: boolean };
    expect(s.items).toHaveLength(3);
    expect(s.count).toBe(3);
    expect(s.has_more).toBe(true);
  });

  it.each([
    ["an envelope", (items: unknown[]) => ({ items })],
    ["a bare array", (items: unknown[]) => items],
  ])(
    "caps a non-paginated list at limit when the upstream returns more (%s)",
    async (_label, wrap) => {
      const client = fakeClient({
        request: () => Promise.resolve(wrap(Array.from({ length: 10 }, (_, i) => ({ i })))),
      });
      const r = await runGenerated({
        client,
        toolName: "test",
        method: "GET",
        path: "/search",
        queryParams: { query: "x", limit: 4 },
        paginated: false,
        responseFormat: "json",
      });
      const s = r.structuredContent as { items: unknown[]; count: number; total?: number };
      expect(s.items).toHaveLength(4);
      expect(s.count).toBe(4);
      expect(s.total).toBe(10);
    },
  );

  it("auto_paginate keeps walking a server-capped page when the ResultPage has next_page", async () => {
    const pages = [
      { items: [{ i: 1 }, { i: 2 }], total_items: "5", next_page: "/API/items?from=2" },
      { items: [{ i: 3 }, { i: 4 }], total_items: "5", next_page: "/API/items?from=4" },
      { items: [{ i: 5 }], total_items: "5", next_page: "" },
    ];
    const froms: unknown[] = [];
    const client = fakeClient({
      request: (_path, opts) => {
        const from = (opts as { query: { from: number } }).query.from;
        froms.push(from);
        return Promise.resolve(pages[froms.length - 1] ?? { items: [] });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      autoPaginate: true,
    });
    const sc = r.structuredContent as { count: number; has_more: boolean };
    expect(sc.count).toBe(5);
    expect(sc.has_more).toBe(false);
    expect(froms).toEqual([0, 2, 4]);
  });

  it("auto_paginate stops on a full page when the ResultPage says it is the last one", async () => {
    let calls = 0;
    const client = fakeClient({
      request: (_path, opts) => {
        calls += 1;
        const limit = (opts as { query: { limit: number } }).query.limit;
        return Promise.resolve({
          items: Array.from({ length: limit }, (_, i) => ({ i })),
          next_page: "",
        });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      autoPaginate: true,
    });
    expect(calls).toBe(1);
    expect((r.structuredContent as { has_more: boolean }).has_more).toBe(false);
  });

  it("rejects a dot-segment path before the destructive guard and without a request", async () => {
    let called = false;
    const client = fakeClient({
      request: () => {
        called = true;
        return Promise.resolve({ ok: true });
      },
    });
    for (const dry_run of [true, false]) {
      const r = await runGenerated({
        client,
        toolName: "action1_delete_role_user",
        method: "DELETE",
        path: "/roles/R1/users/..",
        destructive: { confirm: "YES", dry_run },
      });
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toMatch(/dot segment/);
    }
    expect(called).toBe(false);
  });

  it("auto_paginate forwards filter query params (without pagination keys)", async () => {
    let queryUsed: Record<string, unknown> | null = null;
    const client = fakeClient({
      request: (_path, opts) => {
        queryUsed = (opts as { query?: Record<string, unknown> }).query ?? null;
        return Promise.resolve({ items: [{ id: 1 }] });
      },
    });
    await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      queryParams: { limit: 5, from: 10, search: "foo" },
      autoPaginate: true,
    });
    // pagedFetch sends its own limit + from but the user-supplied filter
    // (`search`) is forwarded.
    expect(queryUsed).toMatchObject({ search: "foo" });
  });

  it("auto_paginate path applies compactItem when verbose !== true (Cluster-D #1)", async () => {
    // Prior bug: auto_paginate / cursor mode bypassed the per-item
    // compactor that the single-call path applied. A response with a
    // 5 000-char embedded script would be returned verbatim from the
    // paginated path while the same record from a non-paginated call
    // would come back truncated. This test pins the new behaviour:
    // both paths run the same compactor under `verbose !== true`.
    const longScript = "x".repeat(5_000);
    const client = fakeClient({
      request: () =>
        Promise.resolve({
          items: [{ id: 1, run_script_text: longScript }],
        }),
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      autoPaginate: true,
    });
    const sc = r.structuredContent as { items: Array<Record<string, unknown>> };
    const script = sc.items[0]!.run_script_text as string;
    expect(script.length).toBeLessThan(longScript.length);
    expect(script).toContain("chars truncated)");
  });

  it("auto_paginate path skips compactor when verbose=true (Cluster-D #1)", async () => {
    const longScript = "y".repeat(5_000);
    const client = fakeClient({
      request: () =>
        Promise.resolve({
          items: [{ id: 1, run_script_text: longScript }],
        }),
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/items",
      autoPaginate: true,
      verbose: true,
    });
    const sc = r.structuredContent as { items: Array<Record<string, unknown>> };
    expect(sc.items[0]!.run_script_text).toBe(longScript);
  });

  it("auto_paginate emits the compactor note only when an item was compacted", async () => {
    const run = (items: unknown[]) =>
      runGenerated({
        client: fakeClient({ request: () => Promise.resolve({ items }) }),
        toolName: "test",
        method: "GET",
        path: "/items",
        autoPaginate: true,
      });
    const compacted = (await run([{ id: 1, run_script_text: "y".repeat(5_000) }]))
      .structuredContent as { note?: string; has_more: boolean };
    expect(compacted.has_more).toBe(false);
    expect(compacted.note).toMatch(/verbose: true/);
    const small = (await run([{ id: 1, x: "small" }])).structuredContent as { note?: string };
    expect(small.note).toBeUndefined();
  });

  it("destructive guard short-circuits when dry_run=true (default)", async () => {
    let called = false;
    const client = fakeClient({
      request: () => {
        called = true;
        return Promise.resolve({ ok: true });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test_destructive",
      method: "POST",
      path: "/x",
      body: { foo: 1 },
      destructive: { dry_run: true },
    });
    expect(called).toBe(false);
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { dry_run: boolean }).dry_run).toBe(true);
  });

  it("envelope-list path emits `count` even when not truncated", async () => {
    // Bug history: runtime previously set `count` only on truncated
    // responses, while listOutputShape requires it on every payload.
    // This caused tools like action1_list_endpoint_groups to fail
    // structured-content validation on the happy path.
    const client = fakeClient({
      request: () => Promise.resolve({ id: "1", type: "ResultPage", items: [{ a: 1 }, { b: 2 }] }),
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/list",
    });
    const sc = r.structuredContent as { items: unknown[]; count: number };
    expect(sc.items).toHaveLength(2);
    expect(sc.count).toBe(2);
  });

  it("envelope-list path passes upstream extra keys through to structured", async () => {
    // Action1 envelopes often carry `id`, `type`, `next`, etc. that
    // the agent may want to read. The list-shape passthrough must
    // preserve them.
    const client = fakeClient({
      request: () => Promise.resolve({ id: "abc", type: "ResultPage", items: [{ x: 1 }] }),
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/list",
    });
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.id).toBe("abc");
    expect(sc.type).toBe("ResultPage");
  });

  it("converts thrown Action1ApiError into a tool error result", async () => {
    const { Action1ApiError } = await import("../../src/client/errors.js");
    const client = fakeClient({
      request: () => {
        throw new Action1ApiError({
          status: 403,
          method: "GET",
          url: "https://example/api/x",
          body: "{}",
          hint: "test hint",
        });
      },
    });
    const r = await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/x",
    });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("HTTP 403");
    expect((r.content[0] as { text: string }).text).toContain("test hint");
  });
});

describe("toQueryValue (via runGenerated stripUndefined)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("joins arrays with commas", async () => {
    let queryUsed: unknown = null;
    const client = fakeClient({
      request: (_path, opts) => {
        queryUsed = (opts as { query?: unknown }).query;
        return Promise.resolve({});
      },
    });
    await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/x",
      queryParams: { tags: ["a", "b", "c"] },
    });
    expect((queryUsed as { tags: string }).tags).toBe("a,b,c");
  });

  it("strips undefined keys", async () => {
    let queryUsed: unknown = null;
    const client = fakeClient({
      request: (_path, opts) => {
        queryUsed = (opts as { query?: unknown }).query;
        return Promise.resolve({});
      },
    });
    await runGenerated({
      client,
      toolName: "test",
      method: "GET",
      path: "/x",
      queryParams: { keep: "yes", drop: undefined, also_drop: null },
    });
    expect(queryUsed).toEqual({ keep: "yes" });
  });
});
