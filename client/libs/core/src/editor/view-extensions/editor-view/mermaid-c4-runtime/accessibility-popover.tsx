// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  MyoxusTextarea,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  C4_ACCESSIBILITY_FORMS,
  c4AccessibilityForm,
  c4AccessibilityRecordHasEffect,
  editC4AccessibilityRecord,
  createC4AccessibilityRecord,
  mermaidMessages as m,
  type C4AccessibilityForm,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  useC4CommandPreview,
  useC4Draft,
} from "./drafts";

/** Each physical metadata record keeps its native form and its own draft. */
export function C4AccessibilityControls({
  props,
  onClose,
}: {
  props: C4ReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n();
  const records = props.model.sourceDocument.records.filter(
    (r) =>
      r.kind === "accessibility-title" ||
      r.kind === "accessibility-description",
  );
  return (
    <Accordion>
      {records.map((record) => (
        <AccordionItem key={record.sourceKey} value={record.sourceKey}>
          <AccordionControl>
            {c4AccessibilityForm(record)} ·{" "}
            {new Intl.NumberFormat(t.language).format(record.range.line)}
          </AccordionControl>
          <AccordionPanel>
            <AccessibilityForm
              props={props}
              sourceKey={record.sourceKey}
              onClose={onClose}
            />
          </AccordionPanel>
        </AccordionItem>
      ))}
      <AccordionItem value="new">
        <AccordionControl>{m.architectureAdd()}</AccordionControl>
        <AccordionPanel>
          <AccessibilityForm props={props} sourceKey={null} onClose={onClose} />
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
function AccessibilityForm({
  props,
  sourceKey,
  onClose,
}: {
  props: C4ReactHostProps;
  sourceKey: string | null;
  onClose: () => void;
}) {
  const t = useI18n(),
    record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    ),
    d = useC4Draft(
      {
        form: record
          ? c4AccessibilityForm(record)
          : ("accTitle:" as C4AccessibilityForm),
        value: record?.value ?? "",
      },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const command = sourceKey
    ? editC4AccessibilityRecord(props.model, sourceKey, d.value.value)
    : createC4AccessibilityRecord(props.model, d.value.form, d.value.value);
  const title = d.value.form === "accTitle:",
    label = title
      ? m.architectureAccessibilityTitle()
      : m.architectureAccessibilityDescription();
  const effective =
    command.model[title ? "accessibilityTitle" : "accessibilityDescription"];
  const latest = command.model.sourceDocument.records.findLast(
    (r) =>
      r.kind ===
        (title ? "accessibility-title" : "accessibility-description") &&
      c4AccessibilityRecordHasEffect(r),
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    const result = sourceKey
      ? d.commit("editC4AccessibilityRecord", [sourceKey, d.value.value])
      : d.commit("createC4AccessibilityRecord", [d.value.form, d.value.value]);
    if (!result.diagnostic) close();
  };
  const showPreview = () =>
    sourceKey
      ? preview.preview("editC4AccessibilityRecord", [sourceKey, d.value.value])
      : preview.preview("createC4AccessibilityRecord", [
          d.value.form,
          d.value.value,
        ]);
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      {!record ? (
        <Select
          label={m.timelineMetadataForm()}
          value={d.value.form}
          data={C4_ACCESSIBILITY_FORMS.map((value) => ({
            value,
            label: value,
          }))}
          disabled={!writable}
          onChange={(value) => {
            const form = C4_ACCESSIBILITY_FORMS.find((f) => f === value);
            if (form) {
              preview.clear();
              d.set("form", form);
            }
          }}
        />
      ) : null}
      {d.value.form === "accDescr {}" ? (
        <MyoxusTextarea
          label={label}
          value={d.value.value}
          disabled={!writable}
          onChange={(value) => {
            preview.clear();
            d.set("value", value);
          }}
        />
      ) : (
        <MyoxusTextInput
          label={label}
          value={d.value.value}
          disabled={!writable}
          onChange={(value) => {
            preview.clear();
            d.set("value", value);
          }}
        />
      )}
      <Text>
        {label}: {effective}
        {record && latest?.sourceKey !== record.sourceKey
          ? ` · ${m.stateNoNativeEffect()}`
          : ""}
      </Text>
      {command.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? command.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || command.status === "invalid"}
            onClick={showPreview}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || command.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
