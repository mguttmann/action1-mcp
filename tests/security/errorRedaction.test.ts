import { describe, expect, it } from "vitest";
import { Action1ApiError, Action1AuthError } from "../../src/client/errors.js";

// Pins the secret-redaction guarantees of the error types that compose
// user-visible (LLM-facing) tool-error text. Two channels:
//   - Action1ApiError: summary line `METHOD redactPath(url) -> HTTP n`
//     plus the redacted response body.
//   - Action1AuthError: a free-form message (often built from an OAuth
//     error body) that the constructor runs through redactString.
//
// redactPath must (a) drop the query string entirely so a `?token=…`
// never lands in the summary, and (b) scrub the surviving origin+path
// so a token-shaped value embedded as a path segment is masked too.

describe("Action1ApiError — URL redaction in summary + toToolErrorText", () => {
  it("drops a token-bearing query string from the summary line", () => {
    const err = new Action1ApiError({
      status: 401,
      url: "https://app.eu.action1.test/api/3.0/things?access_token=supersecretvalue123",
      method: "GET",
      body: "",
    });
    // The query (and therefore the secret) is gone from both the
    // Error message and the tool-error text.
    expect(err.message).not.toContain("supersecretvalue123");
    expect(err.message).not.toContain("access_token");
    expect(err.toToolErrorText()).not.toContain("supersecretvalue123");
    // The non-secret origin + path survives for debug-readability.
    expect(err.toToolErrorText()).toContain("app.eu.action1.test");
    expect(err.toToolErrorText()).toContain("/api/3.0/things");
  });

  it("redacts a JWT-shaped token embedded as a path segment", () => {
    // A bare JWT needs no surrounding whitespace, so the JWT value-pattern
    // catches it even inside a URL pathname (which new URL keeps in its
    // encoded form). Action1 never puts tokens in path segments, but a
    // future / non-Action1 upstream reached via a misconfigured base URL
    // could — this pins that redactPath now scrubs the pathname.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signaturesignaturesignature";
    const err = new Action1ApiError({
      status: 404,
      url: `https://h.test/api/${jwt}/end`,
      method: "GET",
      body: "",
    });
    const text = err.toToolErrorText();
    expect(text).not.toContain(jwt);
    expect(text).toContain("[REDACTED]");
  });

  it("redacts the response body at construction (no raw secret in toToolErrorText)", () => {
    const err = new Action1ApiError({
      status: 400,
      url: "https://app.eu.action1.test/api/3.0/oauth2/token",
      method: "POST",
      body: '{"error":"invalid_client","client_secret":"leakme-32hex-secret-value"}',
    });
    expect(err.body).not.toContain("leakme-32hex-secret-value");
    expect(err.body).toContain("[REDACTED]");
    expect(err.toToolErrorText()).not.toContain("leakme-32hex-secret-value");
  });
});

describe("Action1AuthError — message redaction", () => {
  it("redacts a client_secret echoed in an OAuth error body", () => {
    const err = new Action1AuthError(
      'Token request failed (HTTP 400). Body: {"client_secret":"leakme123secret"}',
    );
    expect(err.message).not.toContain("leakme123secret");
    expect(err.message).toContain("[REDACTED]");
  });

  it("redacts a bare-JWT access_token echoed in the message", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signaturesignaturesignature";
    const err = new Action1AuthError(`Token endpoint replied with ${jwt}`);
    expect(err.message).not.toContain(jwt);
    expect(err.message).toContain("[REDACTED]");
  });
});
