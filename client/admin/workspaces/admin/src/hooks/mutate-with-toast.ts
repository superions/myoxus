/**
 * Thin wrapper around an async mutation that handles the
 * try / success-toast / catch / error-toast boilerplate.
 *
 * Not a hook — can be called freely inside event handlers and callbacks.
 *
 * @example
 * ```ts
 * await mutateWithToast(
 *   () => trigger({ id }),
 *   'Team updated.',
 *   'Update failed',
 * );
 * ```
 *
 * @returns The mutation result on success, or `undefined` on failure.
 */
import { notify } from "@myoxus/ui-facade";

export async function mutateWithToast<T>(
  action: () => Promise<T>,
  successMessage: string | ((result: T) => string),
  errorMessage: string | ((error: Error) => string),
): Promise<T | undefined> {
  try {
    const result = await action();
    const msg =
      typeof successMessage === "function"
        ? successMessage(result)
        : successMessage;
    notify.success({ title: msg });
    return result;
  } catch (e) {
    const err = e as Error;
    const msg =
      typeof errorMessage === "function"
        ? errorMessage(err)
        : `${errorMessage}: ${err.message}`;
    notify.error({ title: msg });
    return undefined;
  }
}
