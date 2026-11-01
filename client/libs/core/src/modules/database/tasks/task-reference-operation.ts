// SPDX-License-Identifier: AGPL-3.0-or-later

/** Transport cancellation must also settle the local insertion/read state when
 * an underlying adapter does not reject its outstanding promise on abort.
 */
export async function waitForTaskReferenceOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
