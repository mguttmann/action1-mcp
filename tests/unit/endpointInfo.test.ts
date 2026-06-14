import { describe, expect, it, vi } from "vitest";
import { fetchEndpointInfo } from "../../src/client/endpointInfo.js";
import { Action1ApiError } from "../../src/client/errors.js";
import type { Action1Client } from "../../src/client/action1Client.js";

// `fetchEndpointInfo` is the canonical-with-fallback resolver for the
// per-endpoint detail view. The canonical Action1 path is
// `/endpoints/managed/{orgId}/{endpointId}` (returns 200 on the public
// spec); some deployments / role boundaries surface 403 / 404 there, so
// the fallback walks `/endpoints/managed/{orgId}` and picks the
// matching id out of the list.

const ORG = "11111111-1111-1111-1111-111111111111";
const ENDPOINT = "aaaa1111-2222-3333-4444-555555555555";

function makeClient(opts: {
  requestImpl: (path: string) => Promise<unknown>;
  paginateImpl?: (path: string) => AsyncGenerator<unknown, void, void>;
}): Action1Client {
  return {
    request: vi.fn(async (path: string) => opts.requestImpl(path)),
    paginate: vi.fn((path: string) => {
      if (opts.paginateImpl) return opts.paginateImpl(path);
      return (async function* () {})();
    }),
  } as unknown as Action1Client;
}

describe("fetchEndpointInfo", () => {
  it("returns canonical result when the canonical path returns 200", async () => {
    const detail = { id: ENDPOINT, hostname: "host-1" };
    const client = makeClient({
      requestImpl: async () => detail,
    });
    const out = await fetchEndpointInfo(client, ORG, ENDPOINT);
    expect(out.source).toBe("canonical");
    expect(out.data).toEqual(detail);
  });

  it("falls back to list walk when canonical returns 403 and finds the endpoint", async () => {
    const detail = { id: ENDPOINT, hostname: "host-2" };
    const client = makeClient({
      requestImpl: async () => {
        throw new Action1ApiError({
          status: 403,
          url: "https://x/y",
          method: "GET",
          body: "forbidden",
        });
      },
      paginateImpl: async function* () {
        yield { id: "some-other", hostname: "other" };
        yield detail;
      },
    });
    const out = await fetchEndpointInfo(client, ORG, ENDPOINT);
    expect(out.source).toBe("list-fallback");
    expect(out.data).toEqual(detail);
  });

  it("falls back to list walk when canonical returns 404 and finds the endpoint", async () => {
    const detail = { id: ENDPOINT, hostname: "host-3" };
    const client = makeClient({
      requestImpl: async () => {
        throw new Action1ApiError({
          status: 404,
          url: "https://x/y",
          method: "GET",
          body: "not found",
        });
      },
      paginateImpl: async function* () {
        yield detail;
      },
    });
    const out = await fetchEndpointInfo(client, ORG, ENDPOINT);
    expect(out.source).toBe("list-fallback");
  });

  it("throws an enriched Action1ApiError when canonical fails and the endpoint is missing from the list", async () => {
    const client = makeClient({
      requestImpl: async () => {
        throw new Action1ApiError({
          status: 404,
          url: "https://x/y",
          method: "GET",
          body: "not found",
        });
      },
      paginateImpl: async function* () {
        yield { id: "other", hostname: "x" };
      },
    });
    await expect(fetchEndpointInfo(client, ORG, ENDPOINT)).rejects.toMatchObject({
      status: 404,
    });
    await expect(fetchEndpointInfo(client, ORG, ENDPOINT)).rejects.toThrow(/not found/i);
  });

  it("propagates non-403/404 errors without trying the fallback", async () => {
    const paginateSpy = vi.fn(async function* () {});
    const client = {
      request: vi.fn(async () => {
        throw new Action1ApiError({
          status: 500,
          url: "https://x/y",
          method: "GET",
          body: "boom",
        });
      }),
      paginate: paginateSpy,
    } as unknown as Action1Client;
    await expect(fetchEndpointInfo(client, ORG, ENDPOINT)).rejects.toMatchObject({
      status: 500,
    });
    expect(paginateSpy).not.toHaveBeenCalled();
  });

  it("URL-encodes the orgId and endpointId in the canonical request path", async () => {
    const seen: string[] = [];
    const client = {
      request: vi.fn(async (path: string) => {
        seen.push(path);
        return { ok: true };
      }),
      paginate: vi.fn(() => (async function* () {})()),
    } as unknown as Action1Client;
    const specialOrg = "org with spaces";
    const specialEp = "ep/withslash";
    await fetchEndpointInfo(client, specialOrg, specialEp);
    expect(seen[0]).toBe(
      `/endpoints/managed/${encodeURIComponent(specialOrg)}/${encodeURIComponent(specialEp)}`,
    );
  });
});
