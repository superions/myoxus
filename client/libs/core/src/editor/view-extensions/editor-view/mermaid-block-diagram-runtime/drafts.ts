// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  useEffect,
  useState,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import type {
  BlockReactHostProps,
  BlockCommandArgs,
  BlockCommandName,
} from "@virgultum/block-mermaid";
import { mermaidMessages as m } from "@virgultum/block-mermaid";
/** A local draft retains the Source basis on which it was opened. */
export function useBlockDraft<T extends object>(
  initial: T,
  props: BlockReactHostProps,
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
  const commit = <K extends BlockCommandName>(
    name: K,
    args: BlockCommandArgs<K>,
  ) => {
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
          ? m.stateSourceConflict()
          : diagnostic,
    basis: basis.current,
  };
}
/** Text fields confirm once; descriptions opt into Enter/Shift+Enter while
 * Notes retain native multiline behavior. Escape discards the local draft. */
export function handleBlockDraftKeyDown(
  event: KeyboardEvent,
  readonly: boolean,
  commit: () => void,
  cancel: () => void,
  confirmMultiline = false,
) {
  if (event.key === "Escape") {
    event.stopPropagation();
    cancel();
  } else if (
    event.key === "Enter" &&
    !event.nativeEvent.isComposing &&
    !readonly &&
    (event.target instanceof HTMLInputElement ||
      (confirmMultiline &&
        !event.shiftKey &&
        event.target instanceof HTMLTextAreaElement)) &&
    !event.target.closest('[role="combobox"], [aria-expanded="true"]')
  ) {
    event.preventDefault();
    event.stopPropagation();
    commit();
  }
}
export function changedBlockFields<T extends object>(
  before: T,
  after: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => value !== before[key as keyof T],
    ),
  ) as Partial<T>;
}

/** Candidate elements share the active viewport and are always disposed before
 * a replacement, Source/history change, rights loss or unmount. */
export function useBlockCommandPreview(props: BlockReactHostProps) {
  const dispose = useRef<(() => void) | null>(null);
  const clear = useCallback(() => {
    dispose.current?.();
    dispose.current = null;
  }, []);
  useEffect(
    () => clear,
    [
      props.sourceBasis,
      props.readonly,
      props.displayOnly,
      props.selected?.key,
      clear,
    ],
  );
  return {
    clear,
    preview: <K extends BlockCommandName>(
      name: K,
      args: BlockCommandArgs<K>,
    ) => {
      clear();
      const result = props.previewCommand?.(name, args, props.sourceBasis);
      dispose.current = result?.dispose ?? null;
      return result?.feedback;
    },
  };
}
