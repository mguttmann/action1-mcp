/**
 * Words that, if they sit immediately before a trim point, signal a
 * grammatically incomplete clause. Used by the codegen's
 * `dropIncompleteTail` to walk back past dangling connectors, and by
 * the integration safety-net test to verify no shipped description
 * ends on one.
 *
 * Lives in its own module so importing the connector list does NOT
 * pull in `generate.ts`'s top-level `main()` (which writes
 * src/tools/generated/index.ts to disk) as a test-time side effect.
 *
 * Coverage:
 *   - prepositions (of/the/a/an/in/on/...)
 *   - conjunctions (and/or/but)
 *   - auxiliaries (are/is/was/were)
 *   - temporal (then/after/before)
 *   - quantifiers (each/all/most/some/any/both/either/neither)
 *   - determiners (one/their/its/this/that/these/those)
 */
export const INCOMPLETE_TAIL_CONNECTORS = [
  "of",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "to",
  "by",
  "with",
  "in",
  "on",
  "at",
  "from",
  "as",
  "into",
  "onto",
  "are",
  "is",
  "was",
  "were",
  "then",
  "after",
  "before",
  "each",
  "all",
  "most",
  "some",
  "any",
  "both",
  "either",
  "neither",
  "one",
  "their",
  "its",
  "this",
  "that",
  "these",
  "those",
] as const;

// Helper for future entries that contain regex-special chars (e.g.
// contracted forms like "can't"). Today's list is ASCII-safe, but the
// helper keeps the regex-construction site future-proof.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tail-pattern: `\b<connector>[.\s]*\.+\s*$` - connector word followed
 * by any combination of dots and whitespace ending the string. The
 * tolerant `[.\s]*\.+\s*$` shape matches both pre-collapse forms
 * ("...the.") and post-collapse forms ("...the..") that the
 * description-builder produces at different stages.
 */
export const INCOMPLETE_TAIL_RE = new RegExp(
  `\\b(${INCOMPLETE_TAIL_CONNECTORS.map(escapeRegex).join("|")})[.\\s]*\\.+\\s*$`,
  "i",
);
