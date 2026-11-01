// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusTextInput,
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
  createC4Relationship,
  C4_RELATIONSHIP_KINDS,
  type C4ReactHostProps,
  type MermaidC4RelationshipKind,
} from "@virgultum/block-mermaid";
import { C4InsertControls } from "./insert-controls";
import { markerText } from "./relationship-marker";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
} from "./drafts";

/** Connect starts on an element and uses the same pair command as the future GFX gesture. */
export function C4ConnectControl({
  props,
  from,
}: {
  props: C4ReactHostProps;
  from: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover
      closeOnEscape={false}
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
          {m.visualConnect()}
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
            <C4ConnectForm
              key={from}
              props={props}
              from={from}
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
export function C4ConnectForm({
  props,
  from,
  onClose,
}: {
  props: C4ReactHostProps;
  from?: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useC4Draft(
      {
        from: from ?? "",
        to: "",
        kind: "Rel" as MermaidC4RelationshipKind,
        label: "",
        parentKey: "",
        beforeKey: "",
      },
      props,
    );
  const preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const sourceAlias = from ?? d.value.from;
  const existing = props.model.relationships.find(
    (r) => r.from === sourceAlias && r.to === d.value.to,
  );
  const valid =
    props.model.elements.some((e) => e.alias === sourceAlias) &&
    props.model.elements.some((e) => e.alias === d.value.to);
  const value = (selectSource = false) => ({
    from: sourceAlias,
    to: d.value.to,
    kind: d.value.kind,
    label: d.value.label,
    selectSource,
    target: {
      parentKey: d.value.parentKey || null,
      beforeKey: d.value.beforeKey || undefined,
    },
  });
  const candidate = valid
    ? createC4Relationship(props.model, value())
    : undefined;
  const projected = candidate?.model.relationships.find(
    (r) => r.from === sourceAlias && r.to === d.value.to,
  );
  const applicable = valid && candidate?.status !== "invalid";
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
  const save = (another = false) => {
    if (!applicable) return;
    preview.clear();
    const feedback = d.commit("createC4Relationship", [value(another)]);
    if (feedback.diagnostic) return;
    if (another && feedback.changed) {
      d.set("to", "");
      d.set("label", "");
    } else close();
  };
  return (
    <Stack
      onKeyDown={(e) => handleC4DraftKeyDown(e, writable, () => save(), close)}
    >
      {from ? (
        <Text>
          {m.chartSource()}: {from}
        </Text>
      ) : (
        <Select
          label={m.chartSource()}
          value={d.value.from}
          disabled={!writable}
          data={props.model.elements.map((e) => ({
            value: e.alias,
            label: `${e.label} · ${e.alias}`,
          }))}
          onChange={(next) => edit("from", next)}
        />
      )}
      <Select
        label={m.chartTarget()}
        value={d.value.to}
        disabled={!writable}
        data={props.model.elements.map((e) => ({
          value: e.alias,
          label: `${e.label} · ${e.alias}`,
        }))}
        onChange={(next) => edit("to", next)}
      />
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
          if (kind) edit("kind", kind);
        }}
      />
      <Text>{markerText(projected)}</Text>
      <Text>{t["com.myoxus.editor.mermaid.c4-direction-attachments"]()}</Text>
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={!writable}
        onChange={(next) => edit("label", next)}
      />
      <C4InsertControls
        props={props}
        value={d.value}
        disabled={!writable}
        onChange={edit}
      />
      {projected ? (
        <Text>
          {projected.label} · {projected.technology} · {projected.description}
        </Text>
      ) : null}
      {candidate?.model.occurrences
        .filter(
          (o) =>
            o.category === "update" &&
            o.selectionId === projected?.resolution!.selectionId,
        )
        .map((o) => {
          const r = candidate.model.sourceDocument.records.find(
            (r) => r.sourceKey === o.sourceKey,
          )!;
          return (
            <Text key={r.sourceKey}>
              {t["com.myoxus.editor.mermaid.c4-record-position"]({
                call: r.callKind!,
                line: new Intl.NumberFormat(t.language).format(r.range.line),
              })}{" "}
              · {o.effectiveFields.join(", ")}
            </Text>
          );
        })}
      {existing ? (
        <Alert>
          {t["com.myoxus.editor.mermaid.c4-pair-exists"]({
            from: sourceAlias,
            to: d.value.to,
          })}
        </Alert>
      ) : null}
      {valid && sourceAlias === d.value.to ? (
        <Text>{t["com.myoxus.editor.mermaid.c4-self-routing"]()}</Text>
      ) : null}
      {d.diagnostic || preview.diagnostic || candidate?.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? candidate?.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && !existing ? (
          <Button
            disabled={!writable || !applicable}
            onClick={() => preview.preview("createC4Relationship", [value()])}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !applicable} onClick={() => save()}>
          {t["Apply"]()}
        </Button>
        <Button
          disabled={!writable || !applicable || !!existing}
          onClick={() => save(true)}
        >
          {t["com.myoxus.editor.mermaid.c4-connect-another"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
