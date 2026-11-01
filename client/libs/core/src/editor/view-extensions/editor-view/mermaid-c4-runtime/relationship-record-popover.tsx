// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  ConfirmModal,
  Group,
  Popover,
  PopoverTarget,
  PopoverContent,
  Select,
  Scrollable,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  C4_RELATIONSHIP_KINDS,
  prepareC4RelationshipNotation,
  c4RelationshipRecordFields,
  type C4ReactHostProps,
  type MermaidC4RelationshipKind,
} from "@virgultum/block-mermaid";
import { C4ArgumentControl, C4SourceValueControl } from "./argument-popover";
import { C4DeleteControl } from "./delete-controls";
import { C4RecordReconnectControl } from "./record-reconnect-popover";
import { markerText } from "./relationship-marker";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
} from "./drafts";

export function C4RelationshipRecordControl({
  props,
  recordKey,
}: {
  props: C4ReactHostProps;
  recordKey: string;
}) {
  const t = useI18n(),
    [opened, setOpened] = useState(false);
  const record = props.model.sourceDocument.records.find(
    (r) => r.sourceKey === recordKey,
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
            <C4RelationshipRecordForm
              props={props}
              recordKey={recordKey}
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
export function C4RelationshipRecordForm({
  props,
  recordKey,
  onClose,
}: {
  props: C4ReactHostProps;
  recordKey: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === recordKey,
    )!;
  const d = useC4Draft(
      { kind: record.callKind! as MermaidC4RelationshipKind },
      props,
    ),
    preview = useC4CommandPreview(props);
  const writable = !props.readonly && !props.displayOnly;
  const [confirmation, setConfirmation] = useState<"loss" | null>(null);
  const prepared = prepareC4RelationshipNotation(
    props.model,
    recordKey,
    d.value.kind,
  );
  const occurrence = props.model.occurrences.find(
    (o) => o.sourceKey === recordKey,
  )!;
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = (confirmed = false) => {
    if (!prepared.draft) return;
    if (prepared.draft.removedIndex !== undefined && !confirmed) {
      setConfirmation("loss");
      return;
    }
    preview.clear();
    if (
      !d.commit("changeC4RelationshipNotation", [prepared.draft, confirmed])
        .diagnostic
    )
      close();
  };
  return (
    <Stack
      onKeyDown={(e) => handleC4DraftKeyDown(e, writable, () => save(), close)}
    >
      <Select
        label={m.blockToken()}
        value={d.value.kind}
        disabled={!writable}
        data={C4_RELATIONSHIP_KINDS.map((kind) => ({
          value: kind,
          label: kind,
        }))}
        onChange={(next) => {
          const kind = C4_RELATIONSHIP_KINDS.find((k) => k === next);
          if (kind) {
            preview.clear();
            d.set("kind", kind);
          }
        }}
      />
      {c4RelationshipRecordFields(props.model, recordKey).map((slot) => (
        <Stack key={slot.index}>
          {slot.argument.key || slot.argument.named ? (
            <C4ArgumentControl
              props={props}
              selectionId={occurrence.selectionId!}
              sourceKey={recordKey}
              argument={slot.argument}
              index={slot.index}
              call={record.callKind!}
              line={record.range.line}
              command="editC4RelationshipArgument"
            />
          ) : (
            <C4SourceValueControl
              props={props}
              selectionId={occurrence.selectionId!}
              sourceKey={recordKey}
              index={slot.index}
              argument={slot.argument}
              field={slot.field}
            />
          )}
          {slot.ignored ? (
            <Text>
              {t["com.myoxus.editor.mermaid.c4-source-slot-ignored"]()}
            </Text>
          ) : null}
        </Stack>
      ))}
      <C4RecordReconnectControl props={props} sourceKey={recordKey} />
      <Text>
        {markerText(
          prepared.model?.relationships.find(
            (r) => r.resolution!.selectionId === occurrence.selectionId,
          ),
        )}
      </Text>
      <Text>{t["com.myoxus.editor.mermaid.c4-direction-attachments"]()}</Text>
      {prepared.draft?.removedIndex !== undefined ? (
        <Text>RelIndex: {prepared.draft.removedIndex} → —</Text>
      ) : null}
      {d.diagnostic || preview.diagnostic || prepared.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand &&
        prepared.draft &&
        prepared.draft.removedIndex === undefined ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("changeC4RelationshipNotation", [
                prepared.draft!,
                false,
              ])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !prepared.draft} onClick={() => save()}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      <C4DeleteControl
        props={props}
        target={{ selectionId: occurrence.selectionId!, recordKey }}
        onDeleted={close}
      />
      <ConfirmModal
        open={confirmation === "loss" && writable}
        onOpenChange={(value) => {
          if (!value) setConfirmation(null);
        }}
        title={t["com.myoxus.editor.mermaid.c4-index-loss"]()}
        confirmText={t["Apply"]()}
        onConfirm={() => save(true)}
      >
        <Text>RelIndex: {prepared.draft?.removedIndex} → —</Text>
      </ConfirmModal>
    </Stack>
  );
}
