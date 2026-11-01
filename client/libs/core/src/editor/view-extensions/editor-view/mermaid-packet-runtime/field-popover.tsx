// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Select,
  Stack,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  type PacketFragment,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidPacketReactHostProps,
  type PacketCommandResult,
} from "@virgultum/block-mermaid";
import { useI18n } from "@myoxus/i18n";
import { useState, type ReactNode } from "react";
import { packetForm, packetDraftCommand, type PacketDraft } from "./drafts";
function sourceFormLabel(form?: "single" | "range" | "count") {
  return form === "single"
    ? messages.packetFormSingle()
    : form === "range"
      ? messages.packetFormRange()
      : messages.packetFormCount();
}
export function PacketImpact({ result }: { result: PacketCommandResult }) {
  const t = useI18n();
  const number = new Intl.NumberFormat(t.language);
  return (
    <Stack>
      <MyoxusText>
        {messages.packetTotalWidth(
          number.format(result.impact.totalWidthAfter),
        )}
      </MyoxusText>
      {result.impact.fields.map((field) => (
        <MyoxusText key={field.id}>
          {field.label}:{" "}
          {field.before
            ? `${number.format(field.before.startBit)}–${number.format(field.before.endBit)}`
            : "∅"}{" "}
          →{" "}
          {field.after
            ? `${number.format(field.after.startBit)}–${number.format(field.after.endBit)}`
            : "∅"}
          {field.sourceFormChanged
            ? ` (${sourceFormLabel(field.before?.sourceForm)} → ${sourceFormLabel(field.after?.sourceForm)})`
            : ""}
        </MyoxusText>
      ))}
    </Stack>
  );
}
function PacketFieldForm({
  props,
  draft,
  onClose,
  onApply,
}: {
  props: MermaidPacketReactHostProps;
  draft: PacketDraft;
  onClose: () => void;
  onApply: (result: PacketCommandResult) => void;
}) {
  const t = useI18n();
  const localeNumber = new Intl.NumberFormat(t.language);
  const [form, setForm] = useState(() => packetForm(props.model, draft));
  const [notice, setNotice] = useState<string>();
  const command = packetDraftCommand(draft, form);
  const preview = props.onPreviewCommand(command, draft.source);
  const readonly = props.readonly || props.displayOnly;
  const field = props.model.fields.find((f) => f.id === draft.fieldKey);
  const index = props.model.fields.findIndex((f) => f.id === draft.fieldKey);
  const neighbors = [
    props.model.fields[index - 1],
    props.model.fields[index + 1],
  ].filter((f) => f !== undefined);
  const merged = neighbors.find((f) => f.id === form.neighborKey);
  const number = (
    key: "startBit" | "endBit" | "width" | "boundary",
    label: string,
  ) => (
    <NumberInput
      label={label}
      value={form[key]}
      disabled={readonly}
      onChange={(value) =>
        setForm({
          ...form,
          [key]: typeof value === "number" ? value : Number.NaN,
        })
      }
    />
  );
  return (
    <Stack data-myoxus-editor-keyboard-owner="packet-field">
      <MyoxusText typographySlot="label-strong">
        {draft.kind === "add"
          ? messages.packetAddField()
          : draft.kind === "split"
            ? messages.packetSplit()
            : draft.kind === "merge"
              ? messages.packetMerge()
              : draft.kind === "delete"
                ? messages.visualDelete()
                : field?.label}
      </MyoxusText>
      {draft.kind !== "delete" ? (
        <MyoxusTextInput
          label={messages.timelineLabel()}
          value={form.label}
          disabled={readonly}
          autoFocus
          onChange={(label) => setForm({ ...form, label })}
        />
      ) : null}
      {draft.kind === "field" ? (
        <>
          {number("startBit", messages.selectedPacketStartBit())}
          {number("endBit", messages.selectedPacketEndBit())}
        </>
      ) : null}
      {draft.kind === "add" ? (
        <>
          {number("width", messages.packetFieldWidth())}
          {field ? (
            <Select
              label={messages.timelineInsertPosition()}
              value={form.position}
              data={[
                { value: "before", label: messages.ganttImpactBefore() },
                { value: "after", label: messages.ganttImpactAfter() },
                { value: "append", label: messages.packetAddField() },
              ]}
              onChange={(value) =>
                setForm({ ...form, position: value as typeof form.position })
              }
            />
          ) : null}
        </>
      ) : null}
      {draft.kind === "split"
        ? number("boundary", messages.packetSplitBoundary())
        : null}
      {draft.kind === "merge" ? (
        <>
          <Select
            label={messages.packetMerge()}
            data={neighbors.map((f) => ({
              value: f.id,
              label: `${f.label} (${sourceFormLabel(f.sourceForm)})`,
            }))}
            value={form.neighborKey || null}
            onChange={(neighborKey) =>
              setForm({ ...form, neighborKey: neighborKey ?? "" })
            }
          />
          <MyoxusText>
            {field?.label} ({sourceFormLabel(field?.sourceForm)}) +{" "}
            {merged?.label} ({sourceFormLabel(merged?.sourceForm)})
          </MyoxusText>
          {(props.model.comments ?? [])
            .filter(
              (c) => c.anchorId === field?.id || c.anchorId === merged?.id,
            )
            .map((c) => (
              <MyoxusText key={c.id}>{c.text}</MyoxusText>
            ))}
        </>
      ) : null}
      {draft.kind !== "delete" ? (
        <Select
          label={messages.timelineMetadataForm()}
          value={form.sourceForm}
          data={(draft.kind === "field"
            ? ["single", "range", "count"]
            : ["range", "count"]
          ).map((value) => ({
            value,
            disabled: value === "single" && form.startBit !== form.endBit,
            label: sourceFormLabel(value as "single" | "range" | "count"),
          }))}
          disabled={readonly}
          onChange={(value) =>
            setForm({ ...form, sourceForm: value as typeof form.sourceForm })
          }
        />
      ) : (
        <MyoxusText>
          {field
            ? messages.packetFieldLabel(
                field.label,
                localeNumber.format(field.startBit),
                localeNumber.format(field.endBit),
                localeNumber.format(field.width),
              )
            : null}
        </MyoxusText>
      )}
      {preview.changed ? <PacketImpact result={preview} /> : null}
      {notice || preview.diagnostic ? (
        <Alert>{notice ?? preview.diagnostic}</Alert>
      ) : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly ? (
          <Button
            variant={draft.kind === "delete" ? "destructive" : undefined}
            disabled={
              preview.status === "rejected" ||
              (draft.kind !== "delete" && !form.label.trim())
            }
            onClick={() => {
              const result = props.onCommand(command, draft.source);
              if (result.changed || result.reason === "no-change") {
                onApply(result);
              } else
                setNotice(
                  result.diagnostic ?? messages.ganttDiagnosticConflict(),
                );
            }}
          >
            {draft.kind === "delete"
              ? messages.visualDelete()
              : messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}

export function PacketFieldPopover({
  props,
  fragment,
  content,
  draft,
  onClose,
  onApply,
}: {
  props: MermaidPacketReactHostProps;
  fragment: PacketFragment;
  content: ReactNode;
  draft?: PacketDraft;
  onClose: () => void;
  onApply: (result: PacketCommandResult) => void;
}) {
  const opened = Boolean(
    draft &&
    (draft.kind === "field" || draft.kind === "delete") &&
    draft.fieldKey === fragment.fieldId &&
    draft.row === fragment.row,
  );
  return (
    <Popover
      opened={opened}
      onChange={(open) => {
        if (!open && opened) onClose();
      }}
      fitViewport
      returnFocus={false}
      trapFocus
      withArrow
    >
      <PopoverTarget>{content}</PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="packet-field">
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened && draft ? (
            <PacketFieldForm
              key={draft.secondKey}
              props={props}
              draft={draft}
              onClose={onClose}
              onApply={onApply}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}

export function PacketDraftAction({
  props,
  kind,
  label,
  disabled,
  draft,
  onOpen,
  onClose,
  onApply,
}: {
  props: MermaidPacketReactHostProps;
  kind: "add" | "split" | "merge";
  label: string;
  disabled: boolean;
  draft?: PacketDraft;
  onOpen: (kind: PacketDraft["kind"]) => void;
  onClose: () => void;
  onApply: (result: PacketCommandResult) => void;
}) {
  const opened = draft?.kind === kind;
  return (
    <Popover
      opened={opened}
      onChange={(open) => {
        if (!open && opened) onClose();
      }}
      fitViewport
      returnFocus={false}
      trapFocus
    >
      <PopoverTarget>
        <Button
          disabled={disabled}
          onClick={() => (opened ? onClose() : onOpen(kind))}
        >
          {label}
        </Button>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="packet-draft">
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened && draft ? (
            <PacketFieldForm
              key={draft.secondKey}
              props={props}
              draft={draft}
              onClose={onClose}
              onApply={onApply}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
