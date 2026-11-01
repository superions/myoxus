// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  mermaidMessages as m,
  sequenceTimelineLabel,
  type SequenceReactHostProps,
  type SequenceCommandName,
  type SequenceCommandArgs,
  type SequenceTimelineAnchor,
} from "@virgultum/block-mermaid";

/** Drafts and native previews are presentation only. The family owns parsing,
 * validation and the one Source/projection commit against this exact basis. */
export function useSequenceDraft<T extends object>(
  initial: T,
  props: SequenceReactHostProps,
) {
  const [value, setValue] = useState(initial),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    [impact, setImpact] = useState<
      readonly { id: string; kind: string; label: string }[]
    >([]),
    basis = useRef(props.sourceBasis),
    latest = useRef(props),
    writable = useRef(!props.readonly && !props.displayOnly);
  latest.current = props;
  const { sourceBasis, readonly, displayOnly } = props;
  useEffect(() => () => latest.current.onCancelPreview(), []);
  useEffect(() => {
    const next = !readonly && !displayOnly;
    if (sourceBasis !== basis.current || (writable.current && !next)) {
      basis.current = sourceBasis;
      latest.current.onCancelPreview();
      latest.current.onCloseSelection();
      latest.current.onParentIntent(null);
    }
    writable.current = next;
  }, [sourceBasis, readonly, displayOnly]);
  const set = <K extends keyof T>(key: K, next: T[K]) => {
    props.onCancelPreview();
    setValue((current) => ({ ...current, [key]: next }));
    setDiagnostic(null);
    setImpact([]);
  };
  const execute = <K extends SequenceCommandName>(
    preview: boolean,
    name: K,
    args: SequenceCommandArgs<K>,
  ) => {
    const result = (preview ? props.onPreview : props.onCommand)(
      name,
      args,
      basis.current,
    );
    if (result.changed && result.sourceBasis !== undefined)
      basis.current = result.sourceBasis;
    setDiagnostic(result.diagnostic ?? null);
    setImpact(result.impact?.records ?? []);
    return result;
  };
  return {
    value,
    set,
    diagnostic:
      props.readonly || props.displayOnly ? m.ganttReadOnly() : diagnostic,
    impact,
    commit: <K extends SequenceCommandName>(
      name: K,
      args: SequenceCommandArgs<K>,
    ) => execute(false, name, args),
    preview: <K extends SequenceCommandName>(
      name: K,
      args: SequenceCommandArgs<K>,
    ) => execute(true, name, args),
  };
}
export function changedSequenceFields<T extends object>(
  before: T,
  after: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => value !== before[key as keyof T],
    ),
  ) as Partial<T>;
}
export function handleSequenceDraftKeyDown(
  event: KeyboardEvent,
  readonly: boolean,
  save: () => void,
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
    save();
  }
}
export function sequenceParticipantOptions(props: SequenceReactHostProps) {
  return props.model.participants.map((p) => ({
    value: p.id,
    label: p.label === p.id ? p.label : `${p.label} · ${p.id}`,
  }));
}
export function sequenceTimelineOptions(props: SequenceReactHostProps) {
  return [
    { value: "", label: m.sequenceEnd() },
    ...props.model.sourceDocument.records
      .filter((r) => r.temporal)
      .map((r) => ({
        value: r.sourceKey,
        label: sequenceTimelineLabel(props.model, r.sourceKey),
      })),
  ];
}
export function sequenceDraftAnchor(
  key: string,
  position: "before" | "after" = "before",
): SequenceTimelineAnchor {
  return { key: key || undefined, position };
}
