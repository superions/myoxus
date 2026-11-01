// SPDX-License-Identifier: AGPL-3.0-or-later

export type TemplateInstantiationFailure =
  | "repeat-invalid"
  | "invalid-syntax"
  | "unresolved-variable"
  | "source-unavailable"
  | "building-block-source"
  | "default-in-use"
  | "managed-source"
  | "source-is-target"
  | "local-only-incompatible"
  | "workspace-unavailable"
  | "organization-unavailable"
  | "owner-unit-unavailable"
  | "parent-unavailable"
  | "folder-absent"
  | "folder-ambiguous"
  | "metadata-unavailable"
  | "creator-unavailable"
  | "creation-time-unavailable"
  | "member-fetch"
  | "empty-field"
  | "sync-timeout"
  | "cancelled"
  | "conflict"
  | "rollback-failed"
  | "application-failed";

/** Safe to log the reason, never the cause: providers can include private data. */
export class TemplateInstantiationError extends Error {
  /** Recovery navigation only; never include this identity in copy or logs. */
  readonly targetDocId?: string;
  readonly range?: { start: number; length: number };
  constructor(
    readonly reason: TemplateInstantiationFailure,
    options?: ErrorOptions & {
      targetDocId?: string;
      range?: { start: number; length: number };
    },
  ) {
    super(reason, options);
    this.name = "TemplateInstantiationError";
    this.targetDocId = options?.targetDocId;
    this.range = options?.range;
  }
}

/** Stop waiting without cancelling a shared cache hydration used by other views. */
export function waitForTemplateOperation<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
    if (signal.aborted) onAbort();
  });
}
