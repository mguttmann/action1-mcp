import { collect } from "./pagination.js";
import type { Action1Client } from "./action1Client.js";

interface CachedOrg {
  id: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrgResolver {
  private orgs: CachedOrg[] | undefined;
  private inFlight: Promise<CachedOrg[]> | undefined;
  // TTL keeps the cache effectively process-lifetime for short-running
  // sessions but lets a long-lived stdio host pick up org renames /
  // new tenant onboards without a restart. 5 min is conservative
  // enough that the rename window is short and aggressive enough that
  // hot loops still hit the cache.
  private cachedAt = 0;
  private readonly TTL_MS = 5 * 60_000;

  constructor(private readonly client: Action1Client) {}

  async resolve(input: string): Promise<string> {
    if (!input) throw new Error("resolveOrg requires a non-empty input.");
    if (UUID_RE.test(input)) return input;
    const orgs = await this.list();
    const lc = input.toLowerCase();
    const exactName = orgs.find((o) => o.name.toLowerCase() === lc);
    if (exactName) return exactName.id;
    const startsWith = orgs.find((o) => o.name.toLowerCase().startsWith(lc));
    if (startsWith) return startsWith.id;
    const contains = orgs.filter((o) => o.name.toLowerCase().includes(lc));
    if (contains.length === 1) return contains[0]!.id;
    if (contains.length > 1) {
      throw new Error(
        `Org name "${input}" is ambiguous. Matches: ${contains
          .map((o) => o.name)
          .join(", ")}. Pass the UUID directly to disambiguate.`,
      );
    }
    throw new Error(
      `Org "${input}" not found. Visible orgs: ${orgs.map((o) => o.name).join(", ") || "(none)"}.`,
    );
  }

  invalidate(): void {
    this.orgs = undefined;
    this.cachedAt = 0;
  }

  private async list(): Promise<CachedOrg[]> {
    // Fresh cache → fast-path.
    if (this.orgs && Date.now() - this.cachedAt < this.TTL_MS) return this.orgs;
    // In-flight refresh → dedupe concurrent callers onto one upstream walk.
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const items = await collect(this.client.paginate<unknown>("/organizations", { limit: 100 }));
      const orgs: CachedOrg[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        if (typeof obj.id === "string" && typeof obj.name === "string") {
          orgs.push({ id: obj.id, name: obj.name });
        }
      }
      this.orgs = orgs;
      this.cachedAt = Date.now();
      return orgs;
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }
}
