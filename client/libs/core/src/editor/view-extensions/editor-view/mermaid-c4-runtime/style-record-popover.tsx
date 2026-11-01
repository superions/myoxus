// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  ConfirmModal,
  Group,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  C4_ELEMENT_APPEARANCE_FIELDS,
  C4_RELATIONSHIP_APPEARANCE_FIELDS,
  c4PairFieldImpact,
  c4ElementStyleArgumentEffect,
  c4RelationshipStyleArgumentEffect,
  removeC4ElementStyleRecord,
  removeC4RelationshipStyleRecord,
  type C4ReactHostProps,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import { C4ArgumentControl, C4SourceValueControl } from "./argument-popover";
import {
  useC4Draft,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
} from "./drafts";
function text(value: C4FieldValue | undefined) {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : (value?.text ?? "");
}
export function C4StyleRecordControl({
  props,
  selectionId,
  sourceKey,
  target = "element",
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  target?: "element" | "relationship";
}) {
  const [opened, setOpened] = useState(false),
    t = useI18n(),
    record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    )!;
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened(true)}>
          {t["com.myoxus.editor.mermaid.c4-record-position"]({
            call: record.callKind!,
            line: new Intl.NumberFormat(t.language).format(record.range.line),
          })}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(false))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <C4StyleRecordForm
              props={props}
              selectionId={selectionId}
              sourceKey={sourceKey}
              target={target}
              onClose={() => {
                setOpened(false);
                props.resolveReturnFocusTarget()?.focus();
              }}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function C4StyleRecordForm({
  props,
  selectionId,
  sourceKey,
  onClose,
  target,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  onClose: () => void;
  target: "element" | "relationship";
}) {
  const t = useI18n(),
    d = useC4Draft({}, props),
    [confirming, setConfirming] = useState(false);
  const record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    )!,
    occurrence = props.model.occurrences.find(
      (o) => o.sourceKey === sourceKey,
    )!;
  const remover =
    target === "element"
      ? removeC4ElementStyleRecord
      : removeC4RelationshipStyleRecord;
  const argumentCommand =
    target === "element"
      ? "editC4ElementStyleArgument"
      : "editC4RelationshipStyleArgument";
  const removeCommand =
    target === "element"
      ? "removeC4ElementStyleRecord"
      : "removeC4RelationshipStyleRecord";
  const firstIndex = target === "element" ? 1 : 2;
  const slots =
    target === "element"
      ? C4_ELEMENT_APPEARANCE_FIELDS
      : C4_RELATIONSHIP_APPEARANCE_FIELDS;
  const effect = (index: number) =>
    target === "element"
      ? c4ElementStyleArgumentEffect(props.model, sourceKey, index)
      : c4RelationshipStyleArgumentEffect(props.model, sourceKey, index)
        ? "content"
        : "stored";
  const removed = remover(props.model, selectionId, sourceKey, true),
    writable = !props.readonly && !props.displayOnly;
  const before = (
      target === "element"
        ? [...props.model.elements, ...props.model.boundaries]
        : props.model.relationships
    ).find((e) => e.resolution!.selectionId === selectionId)!,
    after = (
      target === "element"
        ? [...removed.model.elements, ...removed.model.boundaries]
        : removed.model.relationships
    ).find((e) => e.resolution!.selectionId === selectionId);
  return (
    <Stack>
      <Text>
        {t["com.myoxus.editor.mermaid.c4-record-effects"]({
          fields: occurrence.effectiveFields.join(", "),
        })}
      </Text>
      {!occurrence.applied ? <Text>{m.stateNoNativeEffect()}</Text> : null}
      {record.arguments!.slice(firstIndex).map((argument, offset) => (
        <Stack key={offset}>
          {argument.key || argument.named ? (
            <C4ArgumentControl
              props={props}
              selectionId={selectionId}
              sourceKey={sourceKey}
              index={offset + firstIndex}
              argument={argument}
              call={record.callKind!}
              line={record.range.line}
              command={argumentCommand}
            />
          ) : (
            <C4SourceValueControl
              props={props}
              selectionId={selectionId}
              sourceKey={sourceKey}
              index={offset + firstIndex}
              argument={argument}
              field={slots[offset] ?? ""}
              command={argumentCommand}
            />
          )}
          {effect(offset + firstIndex) === "stored" ? (
            <Text>{m.stateNoNativeEffect()}</Text>
          ) : null}
          {effect(offset + firstIndex) === "spacing" ? (
            <Text>
              {t["com.myoxus.editor.mermaid.c4-boundary-sprite-area"]()}
            </Text>
          ) : null}
          {effect(offset + firstIndex) === "technology" ? (
            <Text>
              {t["com.myoxus.editor.mermaid.c4-native-technology-update"]()}
            </Text>
          ) : null}
        </Stack>
      ))}
      <Group>
        <Button disabled={!writable} onClick={() => setConfirming(true)}>
          {t["Delete"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={confirming && writable}
        onOpenChange={setConfirming}
        title={t["Delete"]()}
        confirmText={t["Apply"]()}
        onConfirm={() => {
          if (
            !d.commit(removeCommand, [selectionId, sourceKey, true]).diagnostic
          )
            onClose();
        }}
      >
        <Stack>
          {target === "relationship"
            ? c4PairFieldImpact(props.model, removed.model).map((impact) => (
                <Stack key={impact.selectionId}>
                  <Text>
                    {impact.beforePair ?? "—"} → {impact.afterPair ?? "—"}
                  </Text>
                  {impact.beforeStep !== impact.afterStep ? (
                    <Text>
                      {impact.beforeStep === undefined
                        ? "—"
                        : new Intl.NumberFormat(t.language).format(
                            impact.beforeStep,
                          )}{" "}
                      →{" "}
                      {impact.afterStep === undefined
                        ? "—"
                        : new Intl.NumberFormat(t.language).format(
                            impact.afterStep,
                          )}
                    </Text>
                  ) : null}
                  {impact.fields.map((field) => (
                    <Text key={field.field}>
                      {field.field}: {text(field.before)} →{" "}
                      {text(field.after) || "—"}
                    </Text>
                  ))}
                </Stack>
              ))
            : [
                ...new Set([
                  ...Object.keys(before.resolution!.fields),
                  ...Object.keys(after?.resolution?.fields ?? {}),
                ]),
              ]
                .filter(
                  (field) =>
                    JSON.stringify(before.resolution!.fields[field]) !==
                    JSON.stringify(after?.resolution?.fields[field]),
                )
                .map((field) => (
                  <Text key={field}>
                    {field}: {text(before.resolution!.fields[field])} →{" "}
                    {text(after?.resolution?.fields[field]) || "—"}
                  </Text>
                ))}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
