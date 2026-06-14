/**
 * Promise-based `setTimeout` that respects an `AbortSignal`. Used by the
 * retry layer and the wait-for-automation polling loop. Resolves after
 * `ms` milliseconds; rejects with `AbortError` if the signal fires
 * before that.
 *
 * The two prior in-line copies (in `client/retry.ts` and
 * `tools/workflows.ts`) were identical character-for-character; this
 * single source removes the drift risk.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
