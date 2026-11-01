import { LiveData, Service } from "@myoxus/infra";
import { nanoid } from "nanoid";

import type { WORKSPACE_DIALOG_SCHEMA } from "../constant";
import type { DialogProps, DialogResult, OpenedDialog } from "../types";

export class WorkspaceDialogService extends Service {
  readonly dialogs$ = new LiveData<OpenedDialog<WORKSPACE_DIALOG_SCHEMA>[]>([]);
  private readonly closing = new Map<string, Promise<boolean>>();

  open<T extends keyof WORKSPACE_DIALOG_SCHEMA>(
    type: T,
    props: DialogProps<WORKSPACE_DIALOG_SCHEMA[T]>,
    callback?: (result?: DialogResult<WORKSPACE_DIALOG_SCHEMA[T]>) => void,
    options?: { beforeClose?: () => boolean | Promise<boolean> },
  ): string {
    const id = nanoid();
    this.dialogs$.next([
      ...this.dialogs$.value,
      {
        type,
        props,
        callback,
        id,
        beforeClose: options?.beforeClose,
      } as OpenedDialog<WORKSPACE_DIALOG_SCHEMA>,
    ]);
    return id;
  }

  /** Unguarded closes stay synchronous. Concurrent guarded requests share the
   * owner's decision; neither a supplied result nor closeAll bypasses the veto. */
  close(id: string, result?: unknown): boolean | Promise<boolean> {
    const pending = this.closing.get(id);
    if (pending) return pending;
    const dialog = this.dialogs$.value.find((dialog) => dialog.id === id);
    if (!dialog) return false;
    if (!dialog.beforeClose) return this.finishClose(id, result);
    let decision: boolean | Promise<boolean>;
    try {
      decision = dialog.beforeClose();
    } catch {
      return false;
    }
    if (typeof decision === "boolean")
      return decision && this.finishClose(id, result);
    const operation = decision
      .then(
        (allowed) => allowed && this.finishClose(id, result),
        () => false,
      )
      .finally(() => this.closing.delete(id));
    this.closing.set(id, operation);
    return operation;
  }

  private finishClose(id: string, result?: unknown) {
    const dialog = this.dialogs$.value.find((dialog) => dialog.id === id);
    if (!dialog) return false;
    // Remove before callback: a reentrant close must never invoke it twice.
    this.dialogs$.next(
      this.dialogs$.value.filter((dialog) => dialog.id !== id),
    );
    dialog.callback?.(result as never);
    return true;
  }

  /** Stop at a veto, preserving the guarded owner and every later dialog. New
   * dialogs opened during a decision are not part of this captured close intent. */
  closeAll(): boolean | Promise<boolean> {
    const ids = this.dialogs$.value.map((dialog) => dialog.id);
    const advance = (start: number): boolean | Promise<boolean> => {
      for (let index = start; index < ids.length; index++) {
        if (!this.dialogs$.value.some((dialog) => dialog.id === ids[index]))
          continue;
        const result = this.close(ids[index]);
        if (typeof result !== "boolean")
          return result.then((allowed) => allowed && advance(index + 1));
        if (!result) return false;
      }
      return true;
    };
    return advance(0);
  }
}
