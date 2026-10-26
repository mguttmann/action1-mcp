interface DescItem {
  description?: unknown;
  [key: string]: unknown;
}

// Anchored status-marker match. The original implementation used
// `line.includes(m)` over `["Starting", "Waiting", "Completed"]`,
// which had two failure modes:
//
//   1. A legitimate script output line like
//      "Completed CVE remediation: 3 packages" was dropped because it
//      contains the word "Completed".
//   2. A line like "Waiting for kernel symbols" (real diagnostic
//      output) was dropped because it contains the word "Waiting".
//
// Action1's actual status markers are emitted in the form
// `"<Marker>: <details>"` (e.g. `"Completed: 5 of 5 endpoints"`,
// `"Waiting: queued"`) or as the bare marker on its own. We match
// only those two shapes (anchored to line start, followed by either
// a colon or end-of-line), so user-emitted strings that merely contain
// the keyword survive.
const STATUS_MARKER_RE = /^(Starting|Waiting|Completed)(:|\s*$)/;

export interface FilterResult {
  output: string;
  rawDescriptions: string[];
  skippedStatusLines: number;
}

export function filterEndpointResultDetails(items: unknown): FilterResult {
  const list = Array.isArray(items) ? (items as DescItem[]) : [];
  const allDescriptions: string[] = [];
  const real: string[] = [];
  let skipped = 0;

  for (const item of list) {
    if (typeof item.description !== "string") continue;
    const desc = item.description;
    allDescriptions.push(desc);
    if (isStatusMarker(desc)) {
      skipped += 1;
      continue;
    }
    real.push(desc);
  }

  return {
    output: real.join("\n"),
    rawDescriptions: allDescriptions,
    skippedStatusLines: skipped,
  };
}

export function isStatusMarker(line: string): boolean {
  return STATUS_MARKER_RE.test(line);
}
