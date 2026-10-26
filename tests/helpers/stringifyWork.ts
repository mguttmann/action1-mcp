import { vi } from "vitest";

// Deterministic work counter for the linear-time regression guards.
// Instead of a wall-clock ceiling (flaky on shared CI runners and under
// coverage instrumentation), the tests count how many characters
// JSON.stringify produced while the code under test ran. A linear
// implementation serialises each record a constant number of times; the
// old quadratic variants re-serialised the whole accumulated prefix on
// every step, which shows up as a character count that grows with n².
export async function stringifiedChars<T>(
  run: () => T | Promise<T>,
): Promise<{ result: T; chars: number; calls: number }> {
  const original = JSON.stringify.bind(JSON);
  let chars = 0;
  let calls = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation(((
    ...args: Parameters<typeof JSON.stringify>
  ) => {
    const out = original(...args);
    calls += 1;
    chars += typeof out === "string" ? out.length : 0;
    return out;
  }) as typeof JSON.stringify);
  try {
    const result = await run();
    return { result, chars, calls };
  } finally {
    spy.mockRestore();
  }
}
