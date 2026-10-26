// Read GENERATED_TOOL_MANIFEST and GENERATED_SKIPPED_OPERATIONS out of the
// source of src/tools/generated/index.ts without depending on its layout
// (the code generator formats the file with Prettier, which may wrap an
// entry over several lines). Used by the scripts that generate docs from
// the tool index; tests/unit/generatedManifest.test.ts checks the result
// against the imported module.

const FIELD = /\b(\w+):\s*("(?:[^"\\\n]|\\.)*"|true|false)/g;

/** Source text of the array literal assigned to `export const <name>`. */
function arraySection(source, name) {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${name} not found in the generated index`);
  const open = source.indexOf("= [", start);
  const close = source.indexOf("\n];", open);
  if (open < 0 || close < 0) throw new Error(`${name} is not an array literal`);
  return source.slice(open + 3, close);
}

/** Flat records in source order; a repeated key starts the next record. */
function records(section) {
  const out = [];
  let cur = null;
  for (const m of section.matchAll(FIELD)) {
    if (cur === null || m[1] in cur) {
      cur = {};
      out.push(cur);
    }
    cur[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

/**
 * @returns {{
 *   tools: { name: string, operationId: string, method: string, path: string, destructive: boolean, unsupported: boolean }[],
 *   skipped: { operationId: string, method: string, path: string, toolName: string }[],
 * }}
 */
export function parseGeneratedManifest(source) {
  return {
    tools: records(arraySection(source, "GENERATED_TOOL_MANIFEST")),
    skipped: records(arraySection(source, "GENERATED_SKIPPED_OPERATIONS")),
  };
}
