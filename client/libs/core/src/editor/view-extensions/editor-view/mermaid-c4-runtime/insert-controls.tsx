// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { Select } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";

/** Physical scope/position selectors are shared by element, boundary and Add Child drafts. */
export function C4InsertControls({
  props,
  value,
  disabled,
  onChange,
  parentLocked = false,
}: {
  props: C4ReactHostProps;
  value: { parentKey: string; beforeKey: string };
  disabled: boolean;
  parentLocked?: boolean;
  onChange: (key: "parentKey" | "beforeKey", value: string) => void;
}) {
  const t = useI18n(),
    records = props.model.sourceDocument.records;
  const position = (call: string, line: number) =>
    t["com.myoxus.editor.mermaid.c4-record-position"]({
      call,
      line: new Intl.NumberFormat(t.language).format(line),
    });
  return (
    <>
      <Select
        label={m.chartParent()}
        value={value.parentKey}
        disabled={disabled || parentLocked}
        data={[
          { value: "", label: m.chartRoot() },
          ...records
            .filter((r) => r.kind === "boundary-open" && r.closeKey)
            .map((r) => ({
              value: r.sourceKey,
              label: position(r.arguments![1].value, r.range.line),
            })),
        ]}
        onChange={(next) => {
          onChange("parentKey", next);
          onChange("beforeKey", "");
        }}
      />
      <Select
        label={m.timelineInsertPosition()}
        value={value.beforeKey}
        disabled={disabled}
        data={[
          { value: "", label: t["com.myoxus.editor.mermaid.c4-insert-end"]() },
          ...records
            .filter(
              (r) =>
                r.callKind && (r.scopeKeys.at(-1) ?? "") === value.parentKey,
            )
            .map((r) => ({
              value: r.sourceKey,
              label: position(r.callKind!, r.range.line),
            })),
        ]}
        onChange={(next) => onChange("beforeKey", next)}
      />
    </>
  );
}
