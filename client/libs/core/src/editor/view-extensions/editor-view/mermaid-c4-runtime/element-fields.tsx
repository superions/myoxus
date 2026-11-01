// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  ConfirmModal,
  Group,
  MyoxusTextInput,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  C4_ELEMENT_KINDS,
  C4_ELEMENT_FIELD_KEYS,
  readC4ElementFields,
  prepareC4ElementFields,
  c4ElementBody,
  type C4ReactHostProps,
  type MermaidC4Element,
} from "@virgultum/block-mermaid";
import { C4ArgumentControl } from "./argument-popover";
import { C4AppearanceControl } from "./appearance-popover";
import { C4AliasControl } from "./alias-popover";
import {
  handleC4DraftKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

/** One local draft combines General/Metadata/Appearance; preview remains a disposable projection. */
export function C4ElementEditForm({
  props,
  element,
  onClose,
  children,
}: {
  props: C4ReactHostProps;
  element: MermaidC4Element;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useI18n(),
    d = useC4Draft(readC4ElementFields(element), props),
    preview = useC4CommandPreview(props);
  const [confirmingLoss, setConfirmingLoss] = useState(false);
  const writable = !props.readonly && !props.displayOnly,
    selectionId = element.resolution!.selectionId;
  const prepared = prepareC4ElementFields(props.model, selectionId, d.value);
  const resulting = prepared.model?.elements.find(
    (e) => e.resolution?.selectionId === selectionId,
  );
  const edit = <K extends keyof typeof d.value>(
    key: K,
    value: (typeof d.value)[K],
  ) => {
    preview.clear();
    setConfirmingLoss(false);
    d.set(key, value);
  };
  const close = () => {
    preview.clear();
    setConfirmingLoss(false);
    onClose();
    props.resolveReturnFocusTarget()?.focus();
  };
  const save = (confirmed = false) => {
    preview.clear();
    if (!prepared.draft || !writable) return;
    if (prepared.loss.length && !confirmed) {
      setConfirmingLoss(true);
      return;
    }
    const result = d.commit("editC4ElementFields", [prepared.draft, confirmed]);
    if (!result.diagnostic) close();
  };
  const field = (
    key:
      | "label"
      | "technology"
      | "description"
      | "sprite"
      | "tags"
      | "link"
      | "shape",
    label: string,
    disabled = false,
  ) => {
    const provider = element.resolution!.providers[C4_ELEMENT_FIELD_KEYS[key]];
    const record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === provider?.sourceKey,
    );
    return (
      <MyoxusTextInput
        label={label}
        description={
          record && provider?.form !== "omitted"
            ? t["com.myoxus.editor.mermaid.c4-record-position"]({
                call: record.callKind!,
                line: new Intl.NumberFormat(t.language).format(
                  record.range.line,
                ),
              })
            : provider?.form === "omitted" ||
                ["sprite", "tags", "link", "shape"].includes(key)
              ? t["com.myoxus.editor.mermaid.c4-new-metadata-update"]()
              : undefined
        }
        autoFocus={key === "label"}
        data-autofocus={key === "label" || undefined}
        value={d.value[key]}
        disabled={!writable || disabled}
        onChange={(value) => edit(key, value)}
      />
    );
  };
  const noTechnologySlot = !/^(?:Container|Component)/.test(d.value.kind);
  const named = props.model.sourceDocument.records
    .filter(
      (r) =>
        (r.kind === "element" || r.kind === "element-update") &&
        props.model.occurrences.some(
          (o) => o.sourceKey === r.sourceKey && o.selectionId === selectionId,
        ),
    )
    .flatMap((record) =>
      record.arguments!.flatMap((argument, index) =>
        argument.key || argument.named ? [{ record, argument, index }] : [],
      ),
    );
  return (
    <Stack
      onKeyDown={(event) =>
        handleC4DraftKeyDown(event, writable, () => save(), close)
      }
    >
      <Accordion defaultValue="general">
        <AccordionItem value="general">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.general"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {/* Keep options inside the editor so an option click cannot
                  dismiss its enclosing popover before the draft changes. */}
              <Select
                label={m.erType()}
                value={d.value.kind}
                data={C4_ELEMENT_KINDS.map((value) => ({
                  value,
                  label: value,
                }))}
                disabled={!writable}
                onChange={(value) => edit("kind", value)}
              />
              {field("label", m.timelineLabel())}
              {!noTechnologySlot || d.value.technology
                ? field(
                    "technology",
                    m.selectedC4Technology(),
                    noTechnologySlot,
                  )
                : null}
              {noTechnologySlot && resulting?.technology ? (
                <Text>
                  {t["com.myoxus.editor.mermaid.c4-retained-technology"]()}
                </Text>
              ) : null}
              {field("description", m.selectedC4Description())}
              <C4AliasControl props={props} selectionId={selectionId} />
              {d.value.kind !== element.kind && resulting ? (
                <Stack>
                  <Text>
                    {t["com.myoxus.editor.mermaid.c4-kind-body"]({
                      from: c4ElementBody(element),
                      to: c4ElementBody(resulting),
                    })}
                  </Text>
                  {prepared.argumentImpact.map((i) => (
                    <Text key={i.field}>
                      {t["com.myoxus.editor.mermaid.c4-kind-impact"]({
                        field: i.field,
                        from: new Intl.NumberFormat(t.language).format(
                          i.from + 1,
                        ),
                        to:
                          i.to < 0
                            ? "—"
                            : new Intl.NumberFormat(t.language).format(
                                i.to + 1,
                              ),
                      })}
                    </Text>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionControl>
            {t["com.myoxus.editor.mermaid.metadata"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {field("sprite", m.selectedC4Sprite())}
              {field("tags", m.selectedC4Tags())}
              {field("link", m.selectedC4Link())}
              {named.map(({ record, argument, index }) => (
                <C4ArgumentControl
                  key={`${record.sourceKey}:${index}`}
                  props={props}
                  selectionId={selectionId}
                  sourceKey={record.sourceKey}
                  argument={argument}
                  index={index}
                  call={record.callKind!}
                  line={record.range.line}
                />
              ))}
              {children}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="appearance">
          <AccordionControl>{m.visualAppearance()}</AccordionControl>
          <AccordionPanel>
            <Stack>
              <C4AppearanceControl props={props} selectionId={selectionId} />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {prepared.diagnostic ?? d.diagnostic ?? preview.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && prepared.draft ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("editC4ElementFields", [prepared.draft!, true])
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
      <ConfirmModal
        open={confirmingLoss && writable}
        onOpenChange={setConfirmingLoss}
        title={t["com.myoxus.editor.mermaid.c4-kind-loss"]()}
        confirmText={t["Apply"]()}
        onConfirm={() => save(true)}
      >
        <Stack>
          {prepared.loss.map((loss) => (
            <Text key={loss.index}>
              {loss.argument.key || loss.field}: {loss.argument.value} → —
            </Text>
          ))}
          {resulting ? (
            <Text>
              {m.selectedC4Technology()}: {element.technology} →{" "}
              {resulting.technology || "—"}
            </Text>
          ) : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
