// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { ModalStack, notify } from "@myoxus/ui-facade";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { DatabaseConflictModal } from "./conflict-modal";
import { DATABASE_CONFLICT_ERROR_CODES } from "./types";

type ConflictExtensions = {
  code?: unknown;
  latestState?: unknown;
  data?: { code?: unknown; latestState?: unknown } | null;
};

export interface DatabaseConflictDetails {
  code: string;
  latestStateJson: string | null;
}

/** Extract the stable conflict contract without depending on one error wrapper. */
export function databaseConflictDetails(
  error: unknown,
): DatabaseConflictDetails | null {
  if (!error || typeof error !== "object") return null;
  const extensions = (error as { extensions?: ConflictExtensions }).extensions;
  if (!extensions) return null;
  const code =
    typeof extensions.code === "string"
      ? extensions.code
      : typeof extensions.data?.code === "string"
        ? extensions.data.code
        : null;
  if (!code || !DATABASE_CONFLICT_ERROR_CODES.includes(code as never)) {
    return null;
  }
  const latestState = extensions.latestState ?? extensions.data?.latestState;
  return {
    code,
    latestStateJson: typeof latestState === "string" ? latestState : null,
  };
}

export interface DatabaseConflictAttempt<T> {
  /** Apply the captured intent; scoped overwrites may refresh unowned values. */
  mutate: (force: boolean) => Promise<T>;
  /**
   * Atomic create/link mutations cannot be retried with force because doing so
   * could duplicate or replace a resource after the opening revision changed.
   */
  allowOverwrite?: boolean;
  /** Recheck current permissions/mapping while a scoped conflict is open. */
  canOverwrite?: () => boolean;
  /** A consumer may discard only its own conflict after read access is lost. */
  scope?: string;
  attemptedAction: string;
  localValue: unknown;
  /** Format the authorized conflict payload or read the current display value.
   * Null means unavailable; omitted preserves the generic conflict formatter. */
  readServerValue?: (
    details: DatabaseConflictDetails,
  ) => Promise<string | null>;
  /** Discard only the draft owned by the conflicting editor, then revalidate. */
  reloadLatest: () => Promise<void> | void;
  afterSuccess?: (result: T) => Promise<void> | void;
  afterForceSuccess?: (result: T) => Promise<void> | void;
}

interface PendingConflict<T = unknown> extends DatabaseConflictAttempt<T> {
  details: DatabaseConflictDetails;
  serverValue?: string | null;
}

export interface DatabaseConflictController {
  execute<T>(attempt: DatabaseConflictAttempt<T>): Promise<T | undefined>;
  dismiss?: (scope: string) => void;
}

const DatabaseConflictContext =
  createContext<DatabaseConflictController | null>(null);

export function DatabaseConflictProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const recoveryRef = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const t = useI18n();

  const execute = useCallback(
    async <T,>(attempt: DatabaseConflictAttempt<T>): Promise<T | undefined> => {
      try {
        const result = await attempt.mutate(false);
        await attempt.afterSuccess?.(result);
        return result;
      } catch (error) {
        const details = databaseConflictDetails(error);
        if (!details) throw error;
        if (attempt.scope && attempt.canOverwrite?.() === false) return;
        const serverValue = await attempt.readServerValue?.(details);
        // A scoped read may outlive dismissal or an actor/row change. Never
        // recreate its private preview after that editor has been disposed.
        if (attempt.scope && attempt.canOverwrite?.() === false) return;
        setPending({
          ...attempt,
          details,
          serverValue,
          mutate: (force) => attempt.mutate(force),
          afterSuccess: attempt.afterSuccess
            ? (result) => attempt.afterSuccess?.(result as T)
            : undefined,
          afterForceSuccess: attempt.afterForceSuccess
            ? (result) => attempt.afterForceSuccess?.(result as T)
            : undefined,
        });
        return undefined;
      }
    },
    [],
  );

  const dismiss = useCallback((scope: string) => {
    setPending((current) => (current?.scope === scope ? null : current));
  }, []);
  // Opening a conflict must not retire its editor's effect lifetime. Consumers
  // use this controller for scope cleanup, independently of modal state.
  const controller = useMemo(() => ({ execute, dismiss }), [execute, dismiss]);

  const close = useCallback(() => {
    if (!recoveryRef.current) setPending(null);
  }, []);
  const reloadLatest = useCallback(async () => {
    const conflict = pending;
    if (!conflict || recoveryRef.current) return;
    recoveryRef.current = true;
    setRecovering(true);
    try {
      await conflict.reloadLatest();
      setPending(null);
    } catch {
      // Retain a recoverable conflict when canonical readback fails. A scoped
      // redaction dismissal may independently remove it while this awaits.
      notify.error({
        title: conflict.attemptedAction,
        message: t["com.myoxus.common.operation-failed"](),
      });
    } finally {
      recoveryRef.current = false;
      setRecovering(false);
    }
  }, [pending, t]);
  const overwrite = useCallback(async () => {
    const conflict = pending;
    if (
      !conflict ||
      conflict.allowOverwrite === false ||
      conflict.canOverwrite?.() === false ||
      recoveryRef.current
    )
      return;
    recoveryRef.current = true;
    setRecovering(true);
    try {
      const result = await conflict.mutate(true);
      setPending(null);
      await (conflict.afterForceSuccess ?? conflict.afterSuccess)?.(result);
    } catch (error) {
      // Scoped overwrites can race again after refreshing the canonical basis.
      // Keep that conflict recoverable instead of leaking a rejected promise.
      const details = databaseConflictDetails(error);
      if (details) {
        try {
          const serverValue = await conflict.readServerValue?.(details);
          if (conflict.scope && conflict.canOverwrite?.() === false) return;
          setPending({ ...conflict, details, serverValue });
        } catch {
          setPending(null);
          notify.error({
            title: conflict.attemptedAction,
            message: t["com.myoxus.common.operation-failed"](),
          });
        }
      } else {
        setPending(null);
        notify.error({
          title: conflict.attemptedAction,
          message: t["com.myoxus.common.operation-failed"](),
          actions: [
            {
              label: t["com.myoxus.database.conflict.reload"](),
              onClick: conflict.reloadLatest,
            },
          ],
        });
      }
    } finally {
      recoveryRef.current = false;
      setRecovering(false);
    }
  }, [pending, t]);

  return (
    <ModalStack>
      <DatabaseConflictContext.Provider value={controller}>
        {children}
        <DatabaseConflictModal
          opened={Boolean(pending)}
          recovering={recovering}
          onClose={close}
          latestStateJson={pending?.details.latestStateJson ?? null}
          serverValue={pending?.serverValue}
          errorCode={pending?.details.code ?? ""}
          attemptedAction={pending?.attemptedAction ?? ""}
          localValue={pending?.localValue ?? null}
          onReloadLatest={() => void reloadLatest()}
          onOverwriteLocal={
            pending?.allowOverwrite === false ||
            pending?.canOverwrite?.() === false
              ? null
              : () => void overwrite()
          }
        />
      </DatabaseConflictContext.Provider>
    </ModalStack>
  );
}

export function useDatabaseConflictController(): DatabaseConflictController {
  const controller = useContext(DatabaseConflictContext);
  if (!controller) {
    throw new Error(
      "Database mutations must render below DatabaseConflictProvider.",
    );
  }
  return controller;
}
