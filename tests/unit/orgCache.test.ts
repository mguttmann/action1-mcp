import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgResolver } from "../../src/client/orgCache.js";
import type { Action1Client } from "../../src/client/action1Client.js";

// `OrgResolver` is the in-memory cache that turns an org name fragment
// or UUID into the canonical UUID. It walks /organizations on first use
// and caches the result; the cache is process-lifetime (no TTL — the
// fleet is small and orgs are stable).

const ORG_A = { id: "11111111-1111-1111-1111-111111111111", name: "Acme Inc" };
const ORG_B = { id: "22222222-2222-2222-2222-222222222222", name: "Beta Corp" };
const ORG_C = { id: "33333333-3333-3333-3333-333333333333", name: "Beta Holdings" };

function makeClient(items: Array<{ id: string; name: string }>): {
  client: Action1Client;
  paginateSpy: ReturnType<typeof vi.fn>;
} {
  const paginateSpy = vi.fn(async function* () {
    for (const it of items) yield it;
  });
  const client = {
    paginate: paginateSpy,
  } as unknown as Action1Client;
  return { client, paginateSpy };
}

describe("OrgResolver", () => {
  it("returns the input verbatim when it is already a UUID", async () => {
    const { client, paginateSpy } = makeClient([ORG_A]);
    const resolver = new OrgResolver(client);
    const out = await resolver.resolve(ORG_A.id);
    expect(out).toBe(ORG_A.id);
    // No need to walk /organizations for a UUID.
    expect(paginateSpy).not.toHaveBeenCalled();
  });

  it("resolves an exact name match (case-insensitive) on the second call", async () => {
    const { client, paginateSpy } = makeClient([ORG_A, ORG_B]);
    const resolver = new OrgResolver(client);
    expect(await resolver.resolve("acme inc")).toBe(ORG_A.id);
    // List walked once.
    expect(paginateSpy).toHaveBeenCalledTimes(1);
    // Subsequent lookups hit the cache.
    expect(await resolver.resolve("Beta Corp")).toBe(ORG_B.id);
    expect(paginateSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves a starts-with match when there is no exact match", async () => {
    const { client } = makeClient([ORG_A, ORG_B]);
    const resolver = new OrgResolver(client);
    expect(await resolver.resolve("Acm")).toBe(ORG_A.id);
  });

  it("throws when the name is ambiguous across multiple orgs", async () => {
    const { client } = makeClient([ORG_B, ORG_C]);
    const resolver = new OrgResolver(client);
    // "Beta" matches "Beta Corp" — starts-with picks the first match
    // (current contract). But "Beta H" matches only one. We test the
    // ambiguous-contains case: a fragment that hits both via .includes().
    await expect(resolver.resolve("eta")).rejects.toThrow(/ambiguous/i);
  });

  it("throws when the name does not match any org", async () => {
    const { client } = makeClient([ORG_A]);
    const resolver = new OrgResolver(client);
    await expect(resolver.resolve("nonexistent")).rejects.toThrow(/not found/i);
  });

  it("invalidate() forces the next lookup to re-walk /organizations", async () => {
    const { client, paginateSpy } = makeClient([ORG_A]);
    const resolver = new OrgResolver(client);
    await resolver.resolve("Acme Inc");
    expect(paginateSpy).toHaveBeenCalledTimes(1);
    resolver.invalidate();
    await resolver.resolve("Acme Inc");
    expect(paginateSpy).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight org-list calls", async () => {
    const { client, paginateSpy } = makeClient([ORG_A, ORG_B]);
    const resolver = new OrgResolver(client);
    const [a, b, c] = await Promise.all([
      resolver.resolve("Acme Inc"),
      resolver.resolve("Beta Corp"),
      resolver.resolve("Acme"),
    ]);
    expect(a).toBe(ORG_A.id);
    expect(b).toBe(ORG_B.id);
    expect(c).toBe(ORG_A.id);
    // Single underlying list walk for the three concurrent calls.
    expect(paginateSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty-string input", async () => {
    const { client } = makeClient([ORG_A]);
    const resolver = new OrgResolver(client);
    await expect(resolver.resolve("")).rejects.toThrow();
  });

  describe("TTL", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-fetches once the 5-minute TTL window expires", async () => {
      vi.useFakeTimers();
      const start = new Date("2025-01-01T00:00:00Z");
      vi.setSystemTime(start);
      const { client, paginateSpy } = makeClient([ORG_A]);
      const resolver = new OrgResolver(client);
      // First call: walks /organizations.
      expect(await resolver.resolve("Acme Inc")).toBe(ORG_A.id);
      expect(paginateSpy).toHaveBeenCalledTimes(1);
      // Just before TTL → still cached.
      vi.setSystemTime(new Date(start.getTime() + 4 * 60_000 + 59_000));
      expect(await resolver.resolve("Acme Inc")).toBe(ORG_A.id);
      expect(paginateSpy).toHaveBeenCalledTimes(1);
      // Past TTL → re-fetch.
      vi.setSystemTime(new Date(start.getTime() + 5 * 60_000 + 1_000));
      expect(await resolver.resolve("Acme Inc")).toBe(ORG_A.id);
      expect(paginateSpy).toHaveBeenCalledTimes(2);
    });

    it("invalidate() resets cachedAt so the next lookup re-fetches even within the TTL window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      const { client, paginateSpy } = makeClient([ORG_A]);
      const resolver = new OrgResolver(client);
      await resolver.resolve("Acme Inc");
      expect(paginateSpy).toHaveBeenCalledTimes(1);
      // Within TTL but invalidate is called explicitly.
      resolver.invalidate();
      await resolver.resolve("Acme Inc");
      expect(paginateSpy).toHaveBeenCalledTimes(2);
    });
  });
});
