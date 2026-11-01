// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  prepareC4RecordMove,
  type C4ReactHostProps,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import { C4InsertControls } from "./insert-controls";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

/** Reparent and lexical reorder are separate local intents; geometry has no entry here. */
export function C4StructureControl({
  props,
  selectionId,
}: {
  props: C4ReactHostProps;
  selectionId: string;
}) {
  const [opened, setOpened] = useState<"reparent" | "reorder" | null>(null),
    t = useI18n();
  const objects = [...props.model.elements, ...props.model.boundaries];
  const owner = objects.find((o) => o.resolution?.selectionId === selectionId);
  if (!owner) return null;
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={!!opened}
      onChange={(value) => {
        if (!value) setOpened(null);
      }}
    >
      <PopoverTarget>
        <Group>
          <Button
            disabled={props.readonly || props.displayOnly}
            onClick={() => setOpened("reparent")}
          >
            {t["com.myoxus.editor.mermaid.c4-reparent"]()}
          </Button>
          <Button
            disabled={props.readonly || props.displayOnly}
            onClick={() => setOpened("reorder")}
          >
            {t["com.myoxus.editor.mermaid.c4-reorder"]()}
          </Button>
        </Group>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(null))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <C4RecordMoveForm
              key={`${selectionId}:${opened}`}
              props={props}
              selectionId={selectionId}
              initialRecordKey={owner.resolution!.declarationKey}
              intent={opened}
              onClose={() => {
                setOpened(null);
                props.resolveReturnFocusTarget()?.focus();
              }}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function C4RecordMoveForm({
  props,
  selectionId,
  initialRecordKey,
  intent,
  onClose,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  initialRecordKey: string;
  intent: "reparent" | "reorder";
  onClose: () => void;
}) {
  const t = useI18n(),
    records = props.model.sourceDocument.records;
  const initial = records.find((r) => r.sourceKey === initialRecordKey)!;
  const d = useC4Draft(
    {
      recordKey: initialRecordKey,
      parentKey: initial.scopeKeys.at(-1) ?? "",
      beforeKey: "",
    },
    props,
  );
  const preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const selected = records.find((r) => r.sourceKey === d.value.recordKey);
  const prepared = prepareC4RecordMove(
    props.model,
    d.value.recordKey,
    {
      parentKey: d.value.parentKey || null,
      beforeKey: d.value.beforeKey || undefined,
    },
    intent,
  );
  const position = (call: string, line: number) =>
    t["com.myoxus.editor.mermaid.c4-record-position"]({
      call,
      line: new Intl.NumberFormat(t.language).format(line),
    });
  const scope = (aliases: readonly string[]) =>
    aliases.length ? aliases.join(" › ") : m.chartRoot();
  const provider = (
    key: string | undefined,
    info?: { call: string; line: number },
  ) => {
    if (info) return position(info.call, info.line);
    const record = records.find((r) => r.sourceKey === key);
    return record ? position(record.callKind!, record.range.line) : "—";
  };
  const value = (v: C4FieldValue | undefined) =>
    typeof v === "number"
      ? new Intl.NumberFormat(t.language).format(v)
      : typeof v === "string"
        ? v
        : (v?.text ?? "—");
  const edit = <K extends keyof typeof d.value>(
    key: K,
    next: (typeof d.value)[K],
  ) => {
    preview.clear();
    d.set(key, next);
  };
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    if (!prepared) return;
    preview.clear();
    if (!d.commit("moveC4SourceRecord", [prepared, true]).diagnostic) close();
  };
  const declarations = records.filter((r) =>
    props.model.occurrences.some(
      (o) =>
        o.sourceKey === r.sourceKey &&
        o.selectionId === selectionId &&
        (o.category === "element" || o.category === "boundary"),
    ),
  );
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={t["com.myoxus.editor.mermaid.c4-records"]({
          count: new Intl.NumberFormat(t.language).format(declarations.length),
        })}
        value={d.value.recordKey}
        disabled={!writable}
        data={declarations.map((r) => ({
          value: r.sourceKey,
          label: position(r.callKind!, r.range.line),
        }))}
        onChange={(key) => {
          const record = records.find((r) => r.sourceKey === key);
          edit("recordKey", key);
          edit("parentKey", record?.scopeKeys.at(-1) ?? "");
          edit("beforeKey", "");
        }}
      />
      <C4InsertControls
        props={props}
        value={d.value}
        disabled={!writable}
        parentLocked={intent === "reorder"}
        onChange={edit}
      />
      {prepared ? (
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            <Text>
              {m.chartParent()}: {scope(prepared.previousScope)} →{" "}
              {scope(prepared.targetScope)}
            </Text>
            <Text>
              {position(selected!.callKind!, prepared.previousLine)} →{" "}
              {position(selected!.callKind!, prepared.targetLine)}
            </Text>
            <Text>
              {prepared.reflowScopes.length
                ? t["com.myoxus.editor.mermaid.c4-move-scopes"]({
                    scopes: prepared.reflowScopes
                      .map((id) =>
                        id ? prepared.objectNames[id] : m.chartRoot(),
                      )
                      .join(", "),
                  })
                : t["com.myoxus.editor.mermaid.c4-move-no-layout"]()}
            </Text>
            <Text>
              {t["com.myoxus.editor.mermaid.c4-move-unit"]({
                count: new Intl.NumberFormat(t.language).format(
                  prepared.movedKeys.length,
                ),
              })}
            </Text>
            {prepared.movedKeys.flatMap((key) => {
              const record = records.find((r) => r.sourceKey === key)!;
              return record.callKind || record.kind === "comment"
                ? [
                    <Text key={key}>
                      {position(
                        record.callKind ?? record.value ?? record.raw.trim(),
                        record.range.line,
                      )}
                    </Text>,
                  ]
                : [];
            })}
            {prepared.impact.map((impact, index) => {
              const name =
                impact.selectionId === "c4-layout"
                  ? m.classApplyLayout()
                  : prepared.objectNames[impact.selectionId];
              return (
                <Stack key={`${impact.selectionId}:${impact.field}:${index}`}>
                  <Text>
                    {name} · {impact.field}: {value(impact.before)} →{" "}
                    {value(impact.after)}
                  </Text>
                  {impact.kind === "field" ? (
                    <Text>
                      {provider(
                        impact.previousProvider,
                        impact.providers?.before,
                      )}{" "}
                      → {provider(impact.nextProvider, impact.providers?.after)}
                    </Text>
                  ) : null}
                </Stack>
              );
            })}
          </Stack>
        </Scrollable.Viewport>
      ) : (
        <Alert color="myoxusError" role="alert">
          {m.classPatchRejected()}
        </Alert>
      )}
      {d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && prepared ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("moveC4SourceRecord", [prepared, true])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !prepared} onClick={save}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
