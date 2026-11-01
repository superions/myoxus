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
  ColorInput,
  Group,
  NumberInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  c4RelationshipStyleRecords,
  readC4RelationshipAppearance,
  editC4RelationshipAppearance,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import { C4StyleRecordControl } from "./style-record-popover";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

export function C4RelationshipAppearanceControl({
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
            <C4RelationshipAppearanceForm
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
function C4RelationshipAppearanceForm({
  props,
  selectionId,
  onClose,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    initial = readC4RelationshipAppearance(props.model, selectionId),
    d = useC4Draft(initial, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const values = {
    textColor: d.value.textColor,
    lineColor: d.value.lineColor,
    offsetX: d.value.offsetX,
    offsetY: d.value.offsetY,
  };
  const prepared = editC4RelationshipAppearance(
      props.model,
      selectionId,
      values,
    ),
    owner = props.model.relationships.find(
      (r) => r.resolution!.selectionId === selectionId,
    )!;
  const origin = (field: "textColor" | "lineColor" | "offsetX" | "offsetY") => {
    const provider = owner.resolution!.providers[field],
      r = props.model.sourceDocument.records.find(
        (r) => r.sourceKey === provider?.sourceKey,
      ),
      fieldValue = owner.resolution!.fields[field];
    const usable =
      typeof fieldValue === "string" ||
      (!["textColor", "lineColor"].includes(field) &&
        typeof fieldValue === "number");
    return r && usable && provider?.form !== "omitted"
      ? t["com.myoxus.editor.mermaid.c4-record-position"]({
          call: r.callKind!,
          line: new Intl.NumberFormat(t.language).format(r.range.line),
        })
      : t["com.myoxus.editor.mermaid.c4-new-relation-update"]();
  };
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (
      !d.commit("editC4RelationshipAppearance", [selectionId, values])
        .diagnostic
    )
      close();
  };
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <ColorInput
        allowEmpty
        fixOnBlur={false}
        label={t["com.myoxus.editor.toolbar.text-color"]()}
        description={origin("textColor")}
        value={d.value.textColor}
        disabled={!writable}
        onChange={(textColor) => {
          preview.clear();
          d.set("textColor", textColor);
        }}
      />
      <ColorInput
        allowEmpty
        fixOnBlur={false}
        label={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.border-color"
        ]()}
        description={origin("lineColor")}
        value={d.value.lineColor}
        disabled={!writable}
        onChange={(lineColor) => {
          preview.clear();
          d.set("lineColor", lineColor);
        }}
      />
      {(["offsetX", "offsetY"] as const).map((field) => (
        <NumberInput
          key={field}
          label={field}
          description={origin(field)}
          value={d.value[field]}
          allowDecimal={false}
          disabled={!writable}
          onChange={(value) => {
            preview.clear();
            d.set(field, typeof value === "number" ? value : Number.NaN);
          }}
        />
      ))}
      <Accordion>
        <AccordionItem value="records">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.c4-style-records"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {c4RelationshipStyleRecords(props.model, selectionId).map((r) => (
                <C4StyleRecordControl
                  key={r.sourceKey}
                  props={props}
                  selectionId={selectionId}
                  sourceKey={r.sourceKey}
                  target="relationship"
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
              preview.preview("editC4RelationshipAppearance", [
                selectionId,
                values,
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
