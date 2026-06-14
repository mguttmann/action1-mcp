import { describe, expect, it } from "vitest";
import { checkBearerHeader } from "../../src/utils/bearerAuth.js";

// Pass-6 review #1: the Bearer-Auth middleware in `runHttp` had a
// production-code change (`(.+)` → `([\s\S]+)`) that was untested.
// `requireBearer` is private inside `runHttp()`, so we extracted the
// validation into the pure function `checkBearerHeader` and test that
// directly. The middleware is now a thin shell that maps the verdict
// to a status code.

const TOKEN = "expected-token-1234567890abcdef";

describe("checkBearerHeader", () => {
  it("returns 'missing' for an undefined Authorization header", () => {
    expect(checkBearerHeader(undefined, TOKEN)).toBe("missing");
  });

  it("returns 'missing' for an empty Authorization header", () => {
    expect(checkBearerHeader("", TOKEN)).toBe("missing");
  });

  it("returns 'missing' for a non-Bearer scheme", () => {
    expect(checkBearerHeader("Basic dXNlcjpwYXNz", TOKEN)).toBe("missing");
    expect(checkBearerHeader("Token xyz", TOKEN)).toBe("missing");
  });

  it("returns 'missing' for `Bearer` without a token", () => {
    expect(checkBearerHeader("Bearer ", TOKEN)).toBe("missing");
    expect(checkBearerHeader("Bearer", TOKEN)).toBe("missing");
  });

  it("returns 'missing' for `Bearer` followed by only whitespace", () => {
    // Pass-8 review: `"Bearer   \t\t"` matches the regex (captured = "\t\t"),
    // trim drops to "" → return "missing". Pin the all-whitespace-token
    // branch so a future refactor that collapses providedStr.length===0
    // back into the timingSafeEqual path (returning "invalid") gets caught.
    expect(checkBearerHeader("Bearer   \t\t", TOKEN)).toBe("missing");
    expect(checkBearerHeader("Bearer    ", TOKEN)).toBe("missing");
    expect(checkBearerHeader("Bearer \r\n", TOKEN)).toBe("missing");
  });

  it("returns 'ok' for a correct Bearer token", () => {
    expect(checkBearerHeader(`Bearer ${TOKEN}`, TOKEN)).toBe("ok");
  });

  it("returns 'invalid' for a wrong token of equal length", () => {
    const wrong = "x".repeat(TOKEN.length);
    expect(checkBearerHeader(`Bearer ${wrong}`, TOKEN)).toBe("invalid");
  });

  it("returns 'invalid' for a wrong-length token (timing-safe early-out)", () => {
    expect(checkBearerHeader("Bearer short", TOKEN)).toBe("invalid");
  });

  it("trims the captured token symmetrically with expectedToken", () => {
    // Pass-4 review: avoid asymmetric trim that would silently 401
    // when the caller pasted a token with stray whitespace.
    expect(checkBearerHeader(`Bearer ${TOKEN}   `, TOKEN)).toBe("ok");
    expect(checkBearerHeader(`Bearer   ${TOKEN}`, TOKEN)).toBe("ok");
  });

  it("tolerates CR/LF inside the captured group", () => {
    // Pass-6 review: the `[\s\S]+` token group accepts headers with
    // literal CR/LF that arrived through a mis-configured proxy.
    // Node's HTTP parser usually strips these, but we are defensive.
    expect(checkBearerHeader(`Bearer ${TOKEN}\r\n`, TOKEN)).toBe("ok");
    expect(checkBearerHeader(`Bearer ${TOKEN}\r`, TOKEN)).toBe("ok");
    expect(checkBearerHeader(`Bearer ${TOKEN}\n`, TOKEN)).toBe("ok");
  });

  it("handles array-valued header (first entry wins)", () => {
    // Express types `req.headers.authorization` as string | string[].
    // Pick the first entry — mirrors Express's own behaviour.
    expect(checkBearerHeader([`Bearer ${TOKEN}`, "garbage"], TOKEN)).toBe("ok");
    expect(checkBearerHeader([], TOKEN)).toBe("missing");
  });

  it("returns 'invalid' for both prefix-wrong and suffix-wrong same-length tokens", () => {
    // Pass-8 review: this is NOT a timing-safe wall-clock test — we
    // can't assert that from userspace JS. It pins the contract that
    // BOTH error positions resolve to the same verdict, which is the
    // visible surface of timing-safe equality (no early-out on the
    // prefix vs. running-to-the-end on the suffix). Node's
    // crypto.timingSafeEqual provides the actual constant-time
    // guarantee; this test only protects against a future refactor
    // that swaps it for `===`.
    const wrongPrefix = "X" + TOKEN.slice(1);
    const wrongSuffix = TOKEN.slice(0, -1) + "X";
    expect(checkBearerHeader(`Bearer ${wrongPrefix}`, TOKEN)).toBe("invalid");
    expect(checkBearerHeader(`Bearer ${wrongSuffix}`, TOKEN)).toBe("invalid");
  });
});
