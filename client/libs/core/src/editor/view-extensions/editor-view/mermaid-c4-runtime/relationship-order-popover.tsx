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
  prepareC4DynamicOrder,
  type C4ReactHostProps,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
} from "./drafts";

export function C4DynamicOrderControl({
  props,
  selectionId,
}: {
  props: C4ReactHostProps;
  selectionId: string;
}) {
  const [opened, setOpened] = useState(false),
    t = useI18n();
  if (props.model.headerLine !== "C4Dynamic") return null;
  return (
    <Popover
      closeOnEscape={false}
      contentMeasure="reading"
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button
          disabled={props.readonly || props.displayOnly}
          onClick={() => setOpened(true)}
        >
          {t["com.myoxus.editor.mermaid.c4-dynamic-reorder"]()}
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
            <C4DynamicOrderForm
              key={selectionId}
              props={props}
              selectionId={selectionId}
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
function C4DynamicOrderForm({
  props,
  selectionId,
  onClose,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    order = props.model.relationships;
  const d = useC4Draft(
    {
      beforePair:
        order[
          order.findIndex((r) => r.resolution!.selectionId === selectionId) + 1
        ]?.resolution!.selectionId ?? "",
    },
    props,
  );
  const preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const prepared = prepareC4DynamicOrder(
    props.model,
    selectionId,
    d.value.beforePair || null,
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    if (!prepared.draft) return;
    preview.clear();
    if (!d.commit("reorderC4DynamicPair", [prepared.draft, true]).diagnostic)
      close();
  };
  const value = (v: C4FieldValue | undefined) =>
    typeof v === "number"
      ? new Intl.NumberFormat(t.language).format(v)
      : typeof v === "string"
        ? v
        : (v?.text ?? "—");
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={m.timelineInsertPosition()}
        value={d.value.beforePair}
        disabled={!writable}
        data={[
          { value: "", label: t["com.myoxus.editor.mermaid.c4-insert-end"]() },
          ...order
            .filter((r) => r.resolution!.selectionId !== selectionId)
            .map((r) => ({
              value: r.resolution!.selectionId,
              label: `${new Intl.NumberFormat(t.language).format(r.dynamicStep!)} · ${r.from} → ${r.to}`,
            })),
        ]}
        onChange={(beforePair) => {
          preview.clear();
          d.set("beforePair", beforePair);
        }}
      />
      <Text>{t["com.myoxus.editor.mermaid.c4-dynamic-first-records"]()}</Text>
      {prepared.draft ? (
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            <Text>
              {prepared.draft.targetScope.join(" › ") || m.chartRoot()} ·{" "}
              {new Intl.NumberFormat(t.language).format(
                prepared.draft.targetLine,
              )}
            </Text>
            {prepared.draft.records.map((r) => (
              <Text key={r.sourceKey}>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: r.call,
                  line: new Intl.NumberFormat(t.language).format(r.line),
                })}{" "}
                · {r.fromScope.join(" › ") || m.chartRoot()}
                {r.firstOccurrence
                  ? ` · ${t["com.myoxus.editor.mermaid.c4-record-first"]()}`
                  : ""}
              </Text>
            ))}
            {prepared.draft.steps.map((step) => (
              <Text key={step.selectionId}>
                {step.from} → {step.to}:{" "}
                {new Intl.NumberFormat(t.language).format(step.before)} →{" "}
                {new Intl.NumberFormat(t.language).format(step.after)}
              </Text>
            ))}
            {prepared.draft.fields.map((field, index) => (
              <Text key={`${field.selectionId}:${field.field}:${index}`}>
                {field.from} → {field.to} · {field.field}: {value(field.before)}{" "}
                → {value(field.after)}
              </Text>
            ))}
          </Stack>
        </Scrollable.Viewport>
      ) : null}
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && prepared.draft ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("reorderC4DynamicPair", [prepared.draft!, true])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !prepared.draft} onClick={save}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
