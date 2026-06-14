import { Action1ApiError } from "./errors.js";
import { collect } from "./pagination.js";
import type { Action1Client } from "./action1Client.js";

export interface EndpointInfoResult {
  data: unknown;
  source: "canonical" | "list-fallback";
}

// Canonical detail path per the official Action1 OpenAPI spec is
// GET /endpoints/managed/{orgId}/{endpointId} (no /general suffix). The /general
// segment that appears in `self` URLs of list responses is a UI-routing artifact,
// not an API path - calling it returns 403. List-fallback stays as a safety net
// in case a future deployment surfaces a different permission boundary.
export async function fetchEndpointInfo(
  client: Action1Client,
  orgId: string,
  endpointId: string,
): Promise<EndpointInfoResult> {
  const canonicalPath =
    "/endpoints/managed/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(endpointId);
  try {
    const data = await client.request<unknown>(canonicalPath);
    return { data, source: "canonical" };
  } catch (err) {
    if (err instanceof Action1ApiError && (err.status === 403 || err.status === 404)) {
      const all = await collect(
        client.paginate<{ id?: unknown }>(
          "/endpoints/managed/" + encodeURIComponent(orgId),
          { limit: 200 },
        ),
      );
      const data = all.find((e) => e.id === endpointId);
      if (!data) {
        throw new Action1ApiError({
          status: err.status,
          url: err.url,
          method: err.method,
          body: err.body,
          hint:
            "Endpoint detail returned " +
            err.status +
            " and the endpoint was also not found in /endpoints/managed/{org}. Verify endpoint_id or check API key scope.",
        });
      }
      return { data, source: "list-fallback" };
    }
    throw err;
  }
}
