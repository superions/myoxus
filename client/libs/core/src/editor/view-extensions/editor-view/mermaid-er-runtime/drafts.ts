// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, useRef, type KeyboardEvent } from "react";
import type {
  ErReactHostProps,
  ErCommandArgs,
  ErCommandName,
} from "@virgultum/block-mermaid";
import { mermaidMessages as m } from "@virgultum/block-mermaid";
/** A local draft retains the Source basis on which it was opened. */
export function useErDraft<T extends object>(
  initial: T,
  props: ErReactHostProps,
) {
  const {
    sourceBasis,
    readonly,
    displayOnly,
    onCloseSelection,
    onParentIntent,
  } = props;
  const initialValue = useRef(initial);
  initialValue.current = initial;
  const [value, setValue] = useState(initial),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    basis = useRef(props.sourceBasis),
    writable = useRef(!props.readonly && !props.displayOnly);
  useEffect(() => {
    const nextWritable = !readonly && !displayOnly;
    // A successful owning command advances the basis synchronously. Only an
    // external Source change or lost rights cancels the still-open draft.
    if (sourceBasis !== basis.current || (writable.current && !nextWritable)) {
      // A comment surface may stay mounted after cancelling its child draft.
      // Discard local values and acknowledge the basis before callbacks render
      // that surface again; otherwise it repeatedly cancels the same change.
      basis.current = sourceBasis;
      setValue(initialValue.current);
      setDiagnostic(null);
      onCloseSelection();
      onParentIntent(null);
    }
    writable.current = nextWritable;
  }, [sourceBasis, readonly, displayOnly, onCloseSelection, onParentIntent]);
  const set = <K extends keyof T>(key: K, next: T[K]) => {
    setValue((current) => ({ ...current, [key]: next }));
    setDiagnostic(null);
  };
  const commit = <K extends ErCommandName>(name: K, args: ErCommandArgs<K>) => {
    const result = props.onCommand(name, args, basis.current, props.placement);
    if (result.changed && result.sourceBasis !== undefined)
      basis.current = result.sourceBasis;
    setDiagnostic(result.diagnostic ?? null);
    return result;
  };
  return {
    value,
    set,
    commit,
    diagnostic:
      props.readonly || props.displayOnly
        ? m.ganttReadOnly()
        : props.sourceBasis !== basis.current
          ? m.erSourceConflict()
          : diagnostic,
    basis: basis.current,
  };
}
/** Text inputs confirm once; comboboxes, buttons and multiline inputs keep
 * their native Enter behavior. Escape discards the local draft. */
export function handleErDraftKeyDown(
  event: KeyboardEvent,
  readonly: boolean,
  commit: () => void,
  cancel: () => void,
) {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancel();
  } else if (
    event.key === "Enter" &&
    !event.nativeEvent.isComposing &&
    !readonly &&
    event.target instanceof HTMLInputElement &&
    !event.target.closest('[role="combobox"], [aria-expanded="true"]')
  ) {
    event.preventDefault();
    event.stopPropagation();
    commit();
  }
}
export function changedErFields<T extends object>(
  before: T,
  after: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => value !== before[key as keyof T],
    ),
  ) as Partial<T>;
}
