// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  Menu,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
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
  c4ElementKindCatalog,
  c4ElementDeclarations,
  c4ElementCallFields,
  type C4ReactHostProps,
  type MermaidC4Element,
  type C4InsertTarget,
  type MermaidC4ElementKind,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";
import { C4ArgumentControl, C4SourceValueControl } from "./argument-popover";
import { C4DeleteControl } from "./delete-controls";
import { C4AliasControl } from "./alias-popover";
import { C4ElementEditForm } from "./element-fields";
import { C4InsertControls } from "./insert-controls";
import { C4ConnectControl } from "./connect-popover";
import { C4StructureControl } from "./structure-popover";

/** Local element controls consume the C4 host and its Source draft ports. */
type C4ElementFormProps = {
  props: C4ReactHostProps;
  element?: MermaidC4Element;
  initialTarget?: C4InsertTarget;
  recordKey?: string;
  onClose: () => void;
};
export function C4ElementForm(input: C4ElementFormProps) {
  return input.element && !input.recordKey ? (
    <C4ElementEditForm
      key={input.element.resolution!.selectionId}
      props={input.props}
      element={input.element}
      onClose={input.onClose}
    >
      <C4DeleteControl
        props={input.props}
        target={{ selectionId: input.element.resolution!.selectionId }}
        onDeleted={input.onClose}
      />
      <C4ElementRecords props={input.props} element={input.element} />
      <C4ConnectControl props={input.props} from={input.element.alias} />
      <C4StructureControl
        props={input.props}
        selectionId={input.element.resolution!.selectionId}
      />
    </C4ElementEditForm>
  ) : (
    <C4ElementBasicForm {...input} />
  );
}
function C4ElementBasicForm({
  props,
  element,
  initialTarget,
  recordKey,
  onClose,
}: {
  props: C4ReactHostProps;
  element?: MermaidC4Element;
  initialTarget?: C4InsertTarget;
  recordKey?: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    catalog = c4ElementKindCatalog(props.model.headerLine);
  const record = recordKey
    ? props.model.sourceDocument.records.find(
        (r) => r.sourceKey === recordKey && r.kind === "element",
      )
    : undefined;
  const d = useC4Draft(
    {
      kind: catalog.initialKind as MermaidC4ElementKind,
      label: record?.arguments?.[1]?.value ?? element?.label ?? "",
      parentKey: initialTarget?.parentKey ?? "",
      beforeKey: initialTarget?.beforeKey ?? "",
    },
    props,
  );
  const writable =
      !props.readonly && !props.displayOnly && (!element || !!record),
    preview = useC4CommandPreview(props);
  const edit = <K extends keyof typeof d.value>(
    key: K,
    value: (typeof d.value)[K],
  ) => {
    preview.clear();
    d.set(key, value);
  };
  const close = () => {
    preview.clear();
    onClose();
    props.resolveReturnFocusTarget()?.focus();
  };
  const save = () => {
    preview.clear();
    const result = element
      ? d.commit("editC4ElementRecordLabel", [recordKey!, d.value.label])
      : d.commit("createC4Element", [
          {
            kind: d.value.kind,
            label: d.value.label,
            target: {
              parentKey: d.value.parentKey || null,
              beforeKey: d.value.beforeKey || undefined,
            },
          },
        ]);
    if (!result.diagnostic) close();
  };
  return (
    <Stack
      onKeyDown={(event) => handleC4DraftKeyDown(event, writable, save, close)}
    >
      {!element ? (
        <>
          <Menu
            noPortal
            title={m.erType()}
            items={
              <Scrollable.Viewport autosize maxHeight="floating">
                <MenuSectionLabel>
                  {t["com.myoxus.editor.mermaid.c4-recommended"]({
                    header: props.model.headerLine,
                  })}
                </MenuSectionLabel>
                {catalog.recommended.map((kind) => (
                  <MenuItem key={kind} onSelect={() => edit("kind", kind)}>
                    {kind}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuSectionLabel>
                  {t["com.myoxus.editor.mermaid.c4-other-kinds"]()}
                </MenuSectionLabel>
                {catalog.additional.map((kind) => (
                  <MenuItem key={kind} onSelect={() => edit("kind", kind)}>
                    {kind}
                  </MenuItem>
                ))}
              </Scrollable.Viewport>
            }
          >
            <Button disabled={!writable}>{d.value.kind}</Button>
          </Menu>
          <C4InsertControls
            props={props}
            value={d.value}
            disabled={!writable}
            onChange={edit}
          />
        </>
      ) : null}
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.timelineLabel()}
        value={d.value.label}
        disabled={!writable}
        onChange={(value) => edit("label", value)}
      />
      {d.diagnostic || preview.diagnostic || (element && !record) ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? m.classPatchRejected()}
        </Alert>
      ) : null}
      <Group>
        {!element && props.previewCommand ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("createC4Element", [
                {
                  kind: d.value.kind,
                  label: d.value.label,
                  target: {
                    parentKey: d.value.parentKey || null,
                    beforeKey: d.value.beforeKey || undefined,
                  },
                },
              ])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable} onClick={save}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      {element ? (
        <C4AliasControl
          props={props}
          selectionId={element.resolution!.selectionId}
          recordKey={record?.sourceKey}
        />
      ) : null}
      {element && record
        ? record.arguments!.slice(2).map((argument, offset) => {
            const index = offset + 2,
              selectionId = element.resolution!.selectionId;
            return argument.key || argument.named ? (
              <C4ArgumentControl
                key={index}
                props={props}
                selectionId={selectionId}
                sourceKey={record.sourceKey}
                index={index}
                argument={argument}
                call={record.callKind!}
                line={record.range.line}
              />
            ) : (
              <C4SourceValueControl
                key={index}
                props={props}
                selectionId={selectionId}
                sourceKey={record.sourceKey}
                index={index}
                argument={argument}
                field={c4ElementCallFields(record.callKind!)[index] ?? ""}
                command="editC4ElementArgument"
              />
            );
          })
        : null}
      {element && record ? (
        <C4DeleteControl
          props={props}
          target={{
            selectionId: element.resolution!.selectionId,
            recordKey: record.sourceKey,
          }}
          onDeleted={onClose}
        />
      ) : null}
    </Stack>
  );
}
function C4ElementRecords({
  props,
  element,
}: {
  props: C4ReactHostProps;
  element: MermaidC4Element;
}) {
  const t = useI18n(),
    declarations = c4ElementDeclarations(
      props.model,
      element.resolution!.selectionId,
    );
  const [opened, setOpened] = useState<string | null>(null);
  if (!declarations.length) return null;
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened !== null}
      onChange={(value) => {
        if (!value) setOpened(null);
      }}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened("")}>
          {t["com.myoxus.editor.mermaid.c4-records"]({
            count: new Intl.NumberFormat(t.language).format(
              declarations.length,
            ),
          })}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(null))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack>
            {declarations.map(({ record, occurrence }) => (
              <Stack key={record.sourceKey}>
                <Button onClick={() => setOpened(record.sourceKey)}>
                  {t["com.myoxus.editor.mermaid.c4-record-position"]({
                    call: record.callKind!,
                    line: new Intl.NumberFormat(t.language).format(
                      record.range.line,
                    ),
                  })}
                </Button>
                <Text>
                  {t["com.myoxus.editor.mermaid.c4-record-effects"]({
                    fields: occurrence.effectiveFields.join(", "),
                  })}
                </Text>
                {record.sourceKey === element.resolution!.sourceKeys[0] ? (
                  <Text>
                    {t["com.myoxus.editor.mermaid.c4-record-first"]()}
                  </Text>
                ) : null}
              </Stack>
            ))}
            {opened ? (
              <C4ElementForm
                key={opened}
                props={props}
                element={element}
                recordKey={opened}
                onClose={() => setOpened(null)}
              />
            ) : null}
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
