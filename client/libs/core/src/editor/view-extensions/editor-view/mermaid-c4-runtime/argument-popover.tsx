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
  Scrollable,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  editC4ElementArgument,
  editC4BoundaryArgument,
  editC4RelationshipArgument,
  editC4ElementStyleArgument,
  editC4RelationshipStyleArgument,
  type C4ReactHostProps,
  type MermaidC4Argument,
} from "@virgultum/block-mermaid";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
} from "./drafts";
const C4_ARGUMENT_COMMANDS = {
  editC4ElementArgument,
  editC4BoundaryArgument,
  editC4RelationshipArgument,
  editC4ElementStyleArgument,
  editC4RelationshipStyleArgument,
};
type C4ArgumentCommand = keyof typeof C4_ARGUMENT_COMMANDS;
export function C4ArgumentControl({
  props,
  selectionId,
  sourceKey,
  argument,
  index,
  call,
  line,
  command = "editC4ElementArgument",
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  argument: MermaidC4Argument;
  index: number;
  call: string;
  line: number;
  command?: C4ArgumentCommand;
}) {
  const [opened, setOpened] = useState(false),
    t = useI18n();
  const occurrence = props.model.occurrences.find(
    (o) => o.sourceKey === sourceKey,
  );
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
          ${argument.key} ·{" "}
          {t["com.myoxus.editor.mermaid.c4-record-position"]({
            call,
            line: new Intl.NumberFormat(t.language).format(line),
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
            <C4ArgumentForm
              key={`${sourceKey}:${index}`}
              props={props}
              selectionId={selectionId}
              sourceKey={sourceKey}
              index={index}
              argument={argument}
              command={command}
              onClose={() => {
                setOpened(false);
                props.resolveReturnFocusTarget()?.focus();
              }}
            />
          ) : null}
          <Text>
            {t["com.myoxus.editor.mermaid.c4-record-effects"]({
              fields: occurrence?.effectiveFields.join(", ") ?? "",
            })}
          </Text>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
function C4ArgumentForm({
  props,
  selectionId,
  sourceKey,
  index,
  argument,
  onClose,
  command,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  index: number;
  argument: MermaidC4Argument;
  onClose: () => void;
  command: C4ArgumentCommand;
}) {
  const t = useI18n(),
    d = useC4Draft({ key: argument.key, value: argument.value }, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const value: MermaidC4Argument = {
    ...argument,
    key: d.value.key,
    value: d.value.value,
    ...(d.value.key ? {} : { named: true as const }),
  };
  const prepare = C4_ARGUMENT_COMMANDS[command];
  const prepared = prepare(props.model, selectionId, sourceKey, index, value);
  const occurrence = prepared.model.occurrences.find(
    (o) => o.sourceKey === sourceKey,
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    const result = d.commit(command, [selectionId, sourceKey, index, value]);
    if (!result.diagnostic) close();
  };
  return (
    <Stack
      onKeyDown={(event) => handleC4DraftKeyDown(event, writable, save, close)}
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={t["com.myoxus.editor.mermaid.argument-key"]()}
        value={d.value.key}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("key", value);
        }}
      />
      <MyoxusTextInput
        label={m.value()}
        value={d.value.value}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("value", value);
        }}
      />
      <Text>
        {t["com.myoxus.editor.mermaid.c4-record-effects"]({
          fields: occurrence?.effectiveFields.join(", ") ?? "",
        })}
      </Text>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {prepared.diagnostic ?? d.diagnostic ?? preview.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() =>
              preview.preview(command, [selectionId, sourceKey, index, value])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}

export function C4SourceValueControl({
  props,
  selectionId,
  sourceKey,
  index,
  argument,
  field,
  command = "editC4RelationshipArgument",
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  index: number;
  argument: MermaidC4Argument;
  field: string;
  command?: C4ArgumentCommand;
}) {
  const [opened, setOpened] = useState(false),
    t = useI18n();
  const labels: Record<string, string> = {
    label: m.timelineLabel(),
    type: m.erType(),
    techn: m.selectedC4Technology(),
    descr: m.selectedC4Description(),
    tags: t["Tags"](),
    link: t["com.myoxus.editor.mermaid.selected-c4-link"](),
    sprite: t["com.myoxus.editor.mermaid.selected-c4-sprite"](),
    index: t["com.myoxus.editor.mermaid.c4-source-index"](),
    bgColor:
      t["com.myoxus.settings.editorSettings.edgeless.shape.fill-color"](),
    fontColor: t["com.myoxus.editor.toolbar.text-color"](),
    borderColor:
      t["com.myoxus.settings.editorSettings.edgeless.shape.border-color"](),
    shape: t["com.myoxus.editor.toolbar.shape"](),
    textColor: t["com.myoxus.editor.toolbar.text-color"](),
    lineColor:
      t["com.myoxus.settings.editorSettings.edgeless.shape.border-color"](),
  };
  const label = labels[field] ?? (field || m.value());
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened(true)}>{label}</Button>
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
            <C4SourceValueForm
              key={`${sourceKey}:${index}`}
              props={props}
              selectionId={selectionId}
              sourceKey={sourceKey}
              index={index}
              argument={argument}
              command={command}
              label={label}
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
function C4SourceValueForm({
  props,
  selectionId,
  sourceKey,
  index,
  argument,
  label,
  onClose,
  command,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  sourceKey: string;
  index: number;
  argument: MermaidC4Argument;
  label: string;
  onClose: () => void;
  command: C4ArgumentCommand;
}) {
  const t = useI18n(),
    d = useC4Draft({ value: argument.value }, props),
    preview = useC4CommandPreview(props);
  const writable = !props.readonly && !props.displayOnly;
  const value = { ...argument, value: d.value.value };
  const prepared = C4_ARGUMENT_COMMANDS[command](
    props.model,
    selectionId,
    sourceKey,
    index,
    value,
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!d.commit(command, [selectionId, sourceKey, index, value]).diagnostic)
      close();
  };
  const occurrence = prepared.model.occurrences.find(
    (o) => o.sourceKey === sourceKey,
  );
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={label}
        disabled={!writable}
        value={d.value.value}
        onChange={(value) => {
          preview.clear();
          d.set("value", value);
        }}
      />
      <Text>
        {t["com.myoxus.editor.mermaid.c4-record-effects"]({
          fields: occurrence?.effectiveFields.join(", ") ?? "",
        })}
      </Text>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() =>
              preview.preview(command, [selectionId, sourceKey, index, value])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
