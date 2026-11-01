// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  Checkbox,
  ColorInput,
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
  C4_SHAPE_KEYWORDS,
  c4ElementStyleRecords,
  editC4ElementAppearance,
  c4ElementBody,
  type C4ReactHostProps,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import { C4StyleRecordControl } from "./style-record-popover";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

export function C4AppearanceControl({
  props,
  selectionId,
}: {
  props: C4ReactHostProps;
  selectionId: string;
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
        <Button onClick={() => setOpened(true)}>{m.visualAppearance()}</Button>
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
            <C4AppearanceForm
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
function text(value: C4FieldValue | undefined) {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : (value?.text ?? "");
}
/** Appearance uses authored content colours, while Facade owns all control chrome. */
function C4AppearanceForm({
  props,
  selectionId,
  onClose,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    owner = [...props.model.elements, ...props.model.boundaries].find(
      (e) => e.resolution!.selectionId === selectionId,
    )!;
  const initial = {
    bgColor: text(owner.resolution!.fields.bgColor),
    fontColor: text(owner.resolution!.fields.fontColor),
    borderColor: text(owner.resolution!.fields.borderColor),
    shape: text(owner.resolution!.fields.shape),
    append: false,
  };
  const d = useC4Draft(initial, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const boundary = props.model.boundaries.some(
    (b) => b.resolution!.selectionId === selectionId,
  );
  const editable = boundary
    ? (["bgColor", "fontColor", "borderColor"] as const)
    : (["bgColor", "fontColor", "borderColor", "shape"] as const);
  const values = Object.fromEntries(
    editable
      .filter((field) =>
        d.value.append
          ? !!d.value[field] || d.value[field] !== initial[field]
          : d.value[field] !== initial[field],
      )
      .map((field) => [field, d.value[field]]),
  );
  const mode = d.value.append ? "append" : "provider",
    prepared = editC4ElementAppearance(props.model, selectionId, values, mode);
  const after = prepared.model.elements.find(
    (e) => e.resolution!.selectionId === selectionId,
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (
      !d.commit("editC4ElementAppearance", [selectionId, values, mode])
        .diagnostic
    )
      close();
  };
  const origin = (field: string) => {
    const provider = owner.resolution!.providers[field],
      record = props.model.sourceDocument.records.find(
        (r) => r.sourceKey === provider?.sourceKey,
      );
    return record &&
      provider?.form !== "omitted" &&
      typeof owner.resolution!.fields[field] === "string"
      ? t["com.myoxus.editor.mermaid.c4-record-position"]({
          call: record.callKind!,
          line: new Intl.NumberFormat(t.language).format(record.range.line),
        })
      : t["com.myoxus.editor.mermaid.c4-new-metadata-update"]();
  };
  const colors = {
    bgColor:
      t["com.myoxus.settings.editorSettings.edgeless.shape.fill-color"](),
    fontColor: t["com.myoxus.editor.toolbar.text-color"](),
    borderColor:
      t["com.myoxus.settings.editorSettings.edgeless.shape.border-color"](),
  };
  const unknown =
    d.value.shape &&
    !C4_SHAPE_KEYWORDS.some(
      (k) => k.toLowerCase() === d.value.shape.toLowerCase(),
    );
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      {(["bgColor", "fontColor", "borderColor"] as const).map((field) => (
        <Stack key={field}>
          <ColorInput
            allowEmpty
            fixOnBlur={false}
            label={colors[field]}
            description={origin(field)}
            value={d.value[field]}
            disabled={!writable}
            onChange={(value) => {
              preview.clear();
              d.set(field, value);
            }}
          />
          {owner.resolution!.fields[field] &&
          typeof owner.resolution!.fields[field] !== "string" ? (
            <Text>{m.stateNoNativeEffect()}</Text>
          ) : null}
        </Stack>
      ))}
      {!boundary ? (
        <>
          <Select
            label={t["com.myoxus.editor.toolbar.shape"]()}
            description={origin("shape")}
            value={d.value.shape}
            disabled={!writable}
            data={[
              { value: "", label: m.optionDefault() },
              ...C4_SHAPE_KEYWORDS.map((shape) => ({
                value: shape,
                label: shape,
              })),
              ...(d.value.shape && !C4_SHAPE_KEYWORDS.includes(d.value.shape)
                ? [{ value: d.value.shape, label: d.value.shape }]
                : []),
            ]}
            onChange={(value) => {
              preview.clear();
              d.set("shape", value);
            }}
          />
          <Text>{t["com.myoxus.editor.mermaid.c4-shape-priority"]()}</Text>
          <Text>
            {m.effectiveValue(
              c4ElementBody(
                after ??
                  props.model.elements.find(
                    (e) => e.resolution!.selectionId === selectionId,
                  )!,
              ),
            )}
          </Text>
          {unknown ? <Text>{m.stateNoNativeEffect()}</Text> : null}
        </>
      ) : null}
      <Checkbox
        label={t["com.myoxus.editor.mermaid.c4-append-style"]()}
        checked={d.value.append}
        disabled={!writable}
        onChange={(event) => {
          preview.clear();
          d.set("append", event.currentTarget.checked);
        }}
      />
      <Accordion>
        <AccordionItem value="records">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.c4-style-records"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {c4ElementStyleRecords(props.model, selectionId).map((r) => (
                <C4StyleRecordControl
                  key={r.sourceKey}
                  props={props}
                  selectionId={selectionId}
                  sourceKey={r.sourceKey}
                />
              ))}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
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
              preview.preview("editC4ElementAppearance", [
                selectionId,
                values,
                mode,
              ])
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
