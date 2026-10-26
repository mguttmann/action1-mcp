// In-memory MCP client/server pair over the real buildServer, for sweeps
// that drive every registered tool and resource through the protocol.

import type { Client } from "@modelcontextprotocol/client";
import { resetConfigCache } from "../../src/config.js";

export const TEST_ORG = "00000000-0000-0000-0000-000000000001";
export const FOREIGN_ORG = "99999999-9999-4999-8999-999999999999";

/** Env switches the sweeps toggle; cleared by `setSweepEnv`. */
const SWEEP_SWITCHES = [
  "ACTION1_ALLOW_DESTRUCTIVE",
  "ACTION1_ALLOW_ACCOUNT_OPS",
  "ACTION1_ALLOW_ENTERPRISE_OPS",
  "ACTION1_DESTRUCTIVE_AUTO_CONFIRM",
  "ACTION1_ALLOWED_ORG_IDS",
  "ACTION1_REDACT_PII",
  "ACTION1_TOOLSETS",
] as const;

/** Base credentials plus the given switches; every other switch is cleared. */
export function setSweepEnv(switches: Partial<Record<(typeof SWEEP_SWITCHES)[number], string>>) {
  process.env.ACTION1_BASE_URL = "https://app.eu.action1.test/api/3.0";
  process.env.ACTION1_CLIENT_ID = "client-id-test";
  process.env.ACTION1_CLIENT_SECRET = "client-secret-test";
  process.env.ACTION1_ORG_ID = TEST_ORG;
  for (const k of SWEEP_SWITCHES) delete process.env[k];
  Object.assign(process.env, switches);
  resetConfigCache();
}

export interface Harness {
  client: Client;
  close: () => Promise<void>;
}

/** Build the real server, connect a client and fetch tools/list once (output validators). */
export async function connectHarness(name: string): Promise<Harness> {
  const { buildServer } = await import("../../src/server.js");
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const built = buildServer();
  await built.server.connect(serverTx);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(clientTx);
  // The client compiles the output-schema validators from tools/list;
  // every later callTool result is checked against them.
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await built.server.close();
    },
  };
}

/** Text of the first content block of a tool result. */
export function resultText(r: { content?: unknown }): string {
  return ((r.content as { text?: string }[] | undefined) ?? [])[0]?.text ?? "";
}

/** Replace every `{param}` of a spec path template: `{orgId}` with `org`, others with `p1`. */
export function concretePath(template: string, org = TEST_ORG): string {
  return template.replace(/\{([^}]+)\}/g, (_m, name: string) => (name === "orgId" ? org : "p1"));
}
