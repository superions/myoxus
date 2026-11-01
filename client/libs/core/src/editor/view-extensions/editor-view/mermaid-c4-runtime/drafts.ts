// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  mermaidMessages as m,
  type C4ReactHostProps,
  type C4CommandArgs,
  type C4CommandName,
} from "@virgultum/block-mermaid";

/** The existing basis/focus pattern keeps local drafts out of document history. */
export function useC4Draft<T extends object>(
  initial: T,
  props: C4ReactHostProps,
) {
  const [value, setValue] = useState(initial),
    [diagnostic, setDiagnostic] = useState<string | null>(null);
  const basis = useRef(props.sourceBasis),
    initialValue = useRef(initial),
    committing = useRef(false),
    object = useRef(props.draftIdentity);
  initialValue.current = initial;
  const writable = !props.readonly && !props.displayOnly,
    previousWritable = useRef(writable);
  useEffect(() => {
    if (
      props.sourceBasis !== basis.current ||
      props.draftIdentity !== object.current ||
      (previousWritable.current && !writable)
    ) {
      basis.current = props.sourceBasis;
      object.current = props.draftIdentity;
      setValue(initialValue.current);
      setDiagnostic(null);
      props.onCloseSelection();
    }
    previousWritable.current = writable;
  }, [
    props.sourceBasis,
    props.draftIdentity,
    writable,
    props.onCloseSelection,
  ]);
  return {
    value,
    diagnostic,
    set: <K extends keyof T>(key: K, next: T[K]) => {
      setValue((current) => ({ ...current, [key]: next }));
      setDiagnostic(null);
    },
    commit: <K extends C4CommandName>(name: K, args: C4CommandArgs<K>) => {
      if (
        committing.current ||
        !writable ||
        basis.current !== props.sourceBasis
      )
        return {
          changed: false,
          diagnostic: !writable ? m.ganttReadOnly() : m.chartSourceChanged(),
        };
      committing.current = true;
      try {
        const result = props.onCommand(name, args, basis.current);
        if (result.changed && result.sourceBasis !== undefined)
          basis.current = result.sourceBasis;
        setDiagnostic(result.diagnostic ?? null);
        return result;
      } finally {
        committing.current = false;
      }
    },
  };
}
/** React portals belong to this control, but are outside its DOM subtree.
 * Keep their clicks out of the enclosing popover's document outside-click listener. */
export function isolateC4PortalledMouseDown(event: MouseEvent<HTMLElement>) {
  if (
    event.target instanceof Node &&
    !event.currentTarget.contains(event.target)
  )
    event.stopPropagation();
}

/** The innermost DOM control owns Escape; portalled children own their own keys. */
export function handleC4PopoverKeyDown(
  event: KeyboardEvent<HTMLElement>,
  close: () => void,
) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    !(event.target instanceof Element) ||
    !event.currentTarget.contains(event.target) ||
    event.target.closest(
      '[role="combobox"][aria-expanded="true"], [role="menu"]',
    )
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

export function handleC4DraftKeyDown(
  event: KeyboardEvent,
  writable: boolean,
  save: () => void,
  cancel: () => void,
) {
  if (
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  )
    return;
  if (
    event.key === "Escape" &&
    event.target instanceof Element &&
    event.target.closest(
      '[role="combobox"][aria-expanded="true"], [role="menu"]',
    )
  ) {
    event.stopPropagation();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  } else if (
    event.key === "Enter" &&
    writable &&
    !event.nativeEvent.isComposing &&
    event.target instanceof HTMLInputElement &&
    !event.target.closest('[role="combobox"], [aria-expanded="true"]')
  ) {
    event.preventDefault();
    event.stopPropagation();
    save();
  }
}

/** Preview owns no persisted model and is disposed on every basis/rights change. */
export function useC4CommandPreview(props: C4ReactHostProps) {
  const disposal = useRef<(() => void) | null>(null),
    [diagnostic, setDiagnostic] = useState<string | null>(null);
  const clear = useCallback(() => {
    disposal.current?.();
    disposal.current = null;
    setDiagnostic(null);
  }, []);
  useEffect(
    () => clear,
    [
      props.sourceBasis,
      props.readonly,
      props.displayOnly,
      props.draftIdentity,
      props.viewportIdentity,
      clear,
    ],
  );
  return {
    clear,
    diagnostic,
    preview: <K extends C4CommandName>(name: K, args: C4CommandArgs<K>) => {
      clear();
      if (props.readonly || props.displayOnly) return;
      const result = props.previewCommand?.(name, args, props.sourceBasis);
      disposal.current = result?.dispose ?? null;
      setDiagnostic(result?.feedback.diagnostic ?? null);
      return result?.feedback;
    },
  };
}
