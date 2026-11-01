// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseConflictController } from "./conflict-controller";

export function executeRevisionMutation<TInput extends object, TResult>(
  conflicts: DatabaseConflictController,
  trigger: (variables: {
    input: TInput & { force?: boolean | null };
  }) => Promise<TResult>,
  input: TInput,
  options: {
    scope?: string;
    canOverwrite?: () => boolean;
    afterForceSuccess?: (result: TResult) => Promise<void> | void;
    afterSuccess?: (result: TResult) => Promise<void> | void;
    attemptedAction: string;
    localValue: unknown;
    readServerValue?: () => Promise<string | null>;
    reloadLatest: () => Promise<void> | void;
  },
): Promise<TResult | undefined> {
  return conflicts.execute({
    ...options,
    mutate: (force) => trigger({ input: { ...input, force } }),
  });
}

/**
 * Execute an optimistic mutation whose GraphQL contract intentionally omits
 * `force`. Conflicts still use the shared modal, but only the safe reload path
 * is offered; replaying Create/Attach/Detach could duplicate or replace data.
 */
export function executeNonForceableRevisionMutation<
  TInput extends object,
  TResult,
>(
  conflicts: DatabaseConflictController,
  trigger: (variables: { input: TInput }) => Promise<TResult>,
  input: TInput,
  options: {
    afterSuccess?: (result: TResult) => Promise<void> | void;
    attemptedAction: string;
    localValue: unknown;
    reloadLatest: () => Promise<void> | void;
  },
): Promise<TResult | undefined> {
  return conflicts.execute({
    ...options,
    allowOverwrite: false,
    mutate: () => trigger({ input }),
  });
}
