// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, type KeyboardEventHandler } from "react";
import {
  mindmapProjectionFingerprint,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

/** Like the Class/ER drafts, each local form retains its opening Source basis.
 * These one-shot forms unmount on close; changed object, rights or persisted
 * projection invalidates them rather than rebasing unsaved values. */
export function useMindmapDraftBasis(
  props: MindmapReactHostProps,
  close: () => void,
) {
  const projection = mindmapProjectionFingerprint(props.projection);
  const initial = useRef({
    source: props.sourceBasis,
    selected: props.selectedKey,
    readonly: props.readonly,
    displayOnly: props.displayOnly,
    projection,
  });
  useEffect(() => {
    const basis = initial.current;
    if (
      props.sourceBasis !== basis.source ||
      props.selectedKey !== basis.selected ||
      props.readonly !== basis.readonly ||
      props.displayOnly !== basis.displayOnly ||
      projection !== basis.projection
    )
      close();
  }, [
    props.sourceBasis,
    props.selectedKey,
    props.readonly,
    props.displayOnly,
    projection,
    close,
  ]);
  return initial.current.source;
}

/** Handle the open list before Mantine changes aria-expanded. The next Escape
 * belongs to the local form, then the existing workbench/owner focus chain. */
export const handleMindmapSelectKeyDown: KeyboardEventHandler<
  HTMLInputElement
> = (event) => {
  if (
    !event.nativeEvent.isComposing &&
    event.key === "Escape" &&
    event.currentTarget.getAttribute("aria-expanded") === "true"
  ) {
    event.preventDefault();
    event.stopPropagation();
  }
};
