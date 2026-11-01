// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef } from "react";

type PendingEdit = { commit(): boolean; discard(): void; focus(): void };

/** Mounted field owners retain their validation/command logic; snapshots never inspect DOM values. */
export class PendingEdits {
  private readonly entries = new Map<object, PendingEdit>();
  onChange?: () => void;
  revealInvalid?: (focus: () => void) => void;
  get dirty() {
    return this.entries.size > 0;
  }
  set(owner: object, edit: PendingEdit | undefined) {
    const wasDirty = this.dirty;
    if (edit) this.entries.set(owner, edit);
    else this.entries.delete(owner);
    if (wasDirty !== this.dirty) this.onChange?.();
  }
  flush(focusInvalid = true) {
    for (const [owner, edit] of this.entries) {
      if (!edit.commit()) {
        if (focusInvalid) {
          if (this.revealInvalid) this.revealInvalid(edit.focus);
          else edit.focus();
        }
        return false;
      }
      this.entries.delete(owner);
    }
    this.onChange?.();
    return true;
  }
  discard() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const edit of entries) edit.discard();
    this.onChange?.();
  }
}
export const PendingEditsContext = createContext<PendingEdits | undefined>(
  undefined,
);

/** Register only uncommitted values. Updating the owner never creates another emission timer. */
export function usePendingEdit(pending: boolean, edit: PendingEdit) {
  const registry = useContext(PendingEditsContext);
  const owner = useRef({});
  useLayoutEffect(() => {
    registry?.set(owner.current, pending ? edit : undefined);
  }, [registry, pending, edit]);
  useLayoutEffect(() => {
    const key = owner.current;
    return () => registry?.set(key, undefined);
  }, [registry]);
}
