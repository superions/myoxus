import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  mermaidMessages as m,
  type GitGraphReactHostProps,
  type GitGraphCommandName,
  type GitGraphCommandArgs,
  type GitGraphFeedback,
  type GitGraphInsertAnchor,
} from "@virgultum/block-mermaid";
export function useGitGraphDraft<T extends object>(
  initial: T,
  props: GitGraphReactHostProps,
) {
  const [value, setValue] = useState(initial),
    [feedback, setFeedback] = useState<GitGraphFeedback | null>(null),
    basis = useRef(props.sourceBasis),
    applied = useRef(false);
  const {
    sourceBasis,
    readonly,
    displayOnly,
    onCancelPreview,
    onCloseSelection,
  } = props;
  useEffect(
    () => () => onCancelPreview(),
    [
      onCancelPreview,
      sourceBasis,
      props.selected?.sourceKey,
      props.viewportIdentity,
    ],
  );
  useEffect(() => {
    if (sourceBasis !== basis.current || readonly || displayOnly) {
      onCancelPreview();
      if (!applied.current) onCloseSelection();
    }
  }, [sourceBasis, readonly, displayOnly, onCancelPreview, onCloseSelection]);
  const run = <K extends GitGraphCommandName>(
    preview: boolean,
    name: K,
    args: GitGraphCommandArgs<K>,
  ) => {
    const result = (preview ? props.onPreview : props.onCommand)(
      name,
      args,
      basis.current,
    );
    if (result.changed) {
      applied.current = true;
      basis.current = result.sourceBasis ?? basis.current;
    }
    setFeedback(result);
    return result;
  };
  return {
    value,
    set: <K extends keyof T>(key: K, next: T[K]) => {
      props.onCancelPreview();
      setValue((old) => ({ ...old, [key]: next }));
      setFeedback(null);
    },
    feedback,
    diagnostic:
      props.readonly || props.displayOnly
        ? m.ganttReadOnly()
        : feedback?.diagnostic,
    run,
  };
}
export function gitGraphDraftKey(
  event: KeyboardEvent,
  save: () => void,
  cancel: () => void,
) {
  if (event.key === "Escape") {
    consumeMyoxusEditorEscape(event.nativeEvent);
    event.preventDefault();
    event.stopPropagation();
    cancel();
  } else if (
    event.key === "Enter" &&
    !event.nativeEvent.isComposing &&
    (event.target instanceof HTMLInputElement ||
      ((event.ctrlKey || event.metaKey) &&
        event.target instanceof HTMLTextAreaElement)) &&
    !event.target.closest('[role="combobox"],[aria-expanded="true"]')
  ) {
    event.preventDefault();
    event.stopPropagation();
    save();
  }
}
export function gitGraphDefaultAnchor(
  props: GitGraphReactHostProps,
): GitGraphInsertAnchor {
  const key = props.selected?.sourceKey;
  return {
    sourceKey:
      key &&
      props.model.sourceDocument!.records.some((r) => r.sourceKey === key)
        ? key
        : null,
    position: "after",
  };
}
