// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useRef } from "react";
import type {
  ClassReactHostProps,
  ClassCommandArgs,
  ClassCommandName,
} from "@virgultum/block-mermaid";
import { mermaidMessages as m } from "@virgultum/block-mermaid";
/** A local draft retains the Source basis on which it was opened. */
export function useClassDraft<T extends object>(
  initial: T,
  props: ClassReactHostProps,
) {
  const [value, setValue] = useState(initial),
    [diagnostic, setDiagnostic] = useState<string | null>(null),
    basis = useRef(props.sourceBasis);
  const set = <K extends keyof T>(key: K, next: T[K]) => {
    setValue((current) => ({ ...current, [key]: next }));
    setDiagnostic(null);
  };
  const commit = <K extends ClassCommandName>(
    name: K,
    args: ClassCommandArgs<K>,
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
          ? m.classSourceConflict()
          : diagnostic,
    basis: basis.current,
  };
}
export function changedClassFields<T extends object>(
  before: T,
  after: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => value !== before[key as keyof T],
    ),
  ) as Partial<T>;
}
