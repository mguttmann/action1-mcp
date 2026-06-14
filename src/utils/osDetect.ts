export type Platform = "windows" | "macos" | "linux" | "unknown";

export function detectPlatform(general: unknown): Platform {
  if (!general || typeof general !== "object") return "unknown";
  const candidates = collectStrings(general).map((s) => s.toLowerCase());
  for (const s of candidates) {
    // Windows Server SKUs ("Windows Server 2022", bare "Server 2019",
    // "Server 2025 Standard") routinely show up *without* the
    // "Windows" prefix in Action1's `os_name` column. Match both
    // the explicit "windows server" phrasing and a bare "server
    // 20xx" SKU year so the auto-routing in execute_and_wait sends
    // a PowerShell payload instead of giving up.
    if (/\bwindows\s+server\b/.test(s)) return "windows";
    if (/\bserver\s+20\d{2}\b/.test(s)) return "windows";
    if (/\bwin(dows)?\b/.test(s)) return "windows";
    if (/\bmac(os)?\b|\bdarwin\b|\bos\s?x\b/.test(s)) return "macos";
    if (/\blinux\b|\bubuntu\b|\bdebian\b|\bfedora\b|\bcentos\b|\brhel\b/.test(s)) return "linux";
  }
  return "unknown";
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth + 1));
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const lookup = new Map<string, unknown>();
    for (const k of Object.keys(obj)) lookup.set(k.toLowerCase(), obj[k]);
    const out: string[] = [];
    for (const key of ["os", "platform", "operating_system", "os_name", "osversion", "name"]) {
      if (lookup.has(key)) out.push(...collectStrings(lookup.get(key), depth + 1));
    }
    return out;
  }
  return [];
}
