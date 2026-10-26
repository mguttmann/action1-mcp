// Body shapes for POST /endpoints/groups/{orgId}/{groupId}/contents.
//
// Per the pinned OpenAPI spec (EndpointGroupContentsPayload) this single
// POST endpoint does BOTH add and remove: the body is an ARRAY whose items
// carry a `method` discriminator. The generated tool typed the body as a
// plain object (z.record) and therefore could never express the array; that
// was the real "modify_group_membership can only add" limitation.
//
// NOTE: the spec array shape is documented but NOT live-proven (the operator's
// live-working add used a bare `{id,type}` object). If a future live smoke
// test 400s on these shapes, capture the real body via the web console's
// network tab and patch here.

export type GroupContentItem =
  | { method: "POST"; data: { endpoint_id: string; type: "Endpoint" } }
  | { method: "DELETE"; endpoint_id: string };

export function buildGroupContentsAdd(endpointId: string): GroupContentItem[] {
  if (!endpointId) throw new Error("endpointId is required");
  return [{ method: "POST", data: { endpoint_id: endpointId, type: "Endpoint" } }];
}

export function buildGroupContentsRemove(endpointId: string): GroupContentItem[] {
  if (!endpointId) throw new Error("endpointId is required");
  return [{ method: "DELETE", endpoint_id: endpointId }];
}
