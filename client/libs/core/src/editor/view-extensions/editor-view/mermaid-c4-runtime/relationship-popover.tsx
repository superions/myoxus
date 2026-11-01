// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  prepareC4Reconnect,
  type C4ReactHostProps,
  type MermaidC4Relationship,
  type C4FieldValue,
} from "@virgultum/block-mermaid";
import { C4DeleteControl } from "./delete-controls";
import { C4LabelOffsetHandle } from "./label-offset-handle";
import { C4RelationshipAppearanceControl } from "./relationship-appearance-popover";
import { C4RelationshipFieldsForm } from "./relationship-fields";
import { C4DynamicOrderControl } from "./relationship-order-popover";
import { C4RelationshipRecordControl } from "./relationship-record-popover";
import {
  useC4Draft,
  useC4CommandPreview,
  handleC4DraftKeyDown,
} from "./drafts";

/** A pair's declarations stay individually reachable; endpoint edits own the entire pair. */
export function C4RelationshipForm({
  props,
  relationship,
  onClose,
}: {
  props: C4ReactHostProps;
  relationship: MermaidC4Relationship;
  onClose: () => void;
}) {
  const t = useI18n(),
    id = relationship.resolution!.selectionId;
  const d = useC4Draft({ from: relationship.from, to: relationship.to }, props),
    preview = useC4CommandPreview(props);
  const writable = !props.readonly && !props.displayOnly;
  const prepared = prepareC4Reconnect(
    props.model,
    id,
    d.value.from,
    d.value.to,
  );
  const next = prepared.model?.relationships.find(
    (r) => r.resolution!.selectionId === id,
  );
  const position = (call: string, line: number) =>
    t["com.myoxus.editor.mermaid.c4-record-position"]({
      call,
      line: new Intl.NumberFormat(t.language).format(line),
    });
  const fieldValue = (value: C4FieldValue | undefined) =>
    typeof value === "number"
      ? new Intl.NumberFormat(t.language).format(value)
      : typeof value === "string"
        ? value
        : (value?.text ?? "—");
  const records = props.model.occurrences.filter(
    (o) => o.category === "relationship" && o.selectionId === id,
  );
  const styles =
    prepared.model?.occurrences.filter(
      (o) => o.category === "update" && o.selectionId === id,
    ) ?? [];
  const close = () => {
    preview.clear();
    onClose();
    props.resolveReturnFocusTarget()?.focus();
  };
  const save = () => {
    if (!prepared.draft) return;
    preview.clear();
    if (!d.commit("reconnectC4Relationship", [prepared.draft, true]).diagnostic)
      close();
  };
  const endpoints = props.model.elements.map((e) => ({
    value: e.alias,
    label: `${e.label} · ${e.alias}`,
  }));
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <C4RelationshipFieldsForm
        key={id}
        props={props}
        relationship={relationship}
      />
      <C4DynamicOrderControl props={props} selectionId={id} />
      <C4DeleteControl
        props={props}
        target={{ selectionId: id }}
        onDeleted={onClose}
      />
      <C4RelationshipAppearanceControl props={props} selectionId={id} />
      <C4LabelOffsetHandle props={props} selectionId={id} />
      <Select
        label={m.chartSource()}
        value={d.value.from}
        disabled={!writable}
        data={endpoints}
        onChange={(from) => {
          preview.clear();
          d.set("from", from);
        }}
      />
      <Select
        label={m.chartTarget()}
        value={d.value.to}
        disabled={!writable}
        data={endpoints}
        onChange={(to) => {
          preview.clear();
          d.set("to", to);
        }}
      />
      {prepared.collision ? (
        <Alert color="myoxusError" role="alert">
          {t["com.myoxus.editor.mermaid.c4-pair-collision"]({
            from: d.value.from,
            to: d.value.to,
          })}
        </Alert>
      ) : null}
      {d.value.from === d.value.to ? (
        <Text>{t["com.myoxus.editor.mermaid.c4-self-routing"]()}</Text>
      ) : null}
      <Scrollable.Viewport autosize maxHeight="floating">
        <Stack>
          {prepared.draft?.impact.map((i) => (
            <Text key={i.sourceKey}>
              {position(i.call, i.line)} · {i.fields.join(", ")}
            </Text>
          ))}
          {prepared.model
            ? [
                ...new Set(
                  [
                    ...props.model.relationships,
                    ...prepared.model.relationships,
                  ].map((r) => r.resolution!.selectionId),
                ),
              ].flatMap((pairId) => {
                const before = props.model.relationships.find(
                  (r) => r.resolution!.selectionId === pairId,
                );
                const after = prepared.model!.relationships.find(
                  (r) => r.resolution!.selectionId === pairId,
                );
                const caption = (r: MermaidC4Relationship | undefined) =>
                  r ? `${r.from} → ${r.to}: ${r.label}` : "—";
                return caption(before) !== caption(after)
                  ? [
                      <Text key={pairId}>
                        {caption(before)} → {caption(after)}
                      </Text>,
                    ]
                  : [];
              })
            : null}
          {next
            ? [
                ...new Set([
                  ...Object.keys(relationship.resolution!.fields),
                  ...Object.keys(next.resolution!.fields),
                ]),
              ].flatMap((field) => {
                const before = relationship.resolution!.fields[field],
                  after = next.resolution!.fields[field];
                return JSON.stringify(before) !== JSON.stringify(after)
                  ? [
                      <Text key={field}>
                        {field}: {fieldValue(before)} → {fieldValue(after)}
                      </Text>,
                    ]
                  : [];
              })
            : null}
          {styles.length ? (
            <Text>{t["com.myoxus.editor.mermaid.c4-pair-styles"]()}</Text>
          ) : null}
          {styles.map((o) => {
            const r = prepared.model!.sourceDocument.records.find(
              (r) => r.sourceKey === o.sourceKey,
            )!;
            return (
              <Text key={r.sourceKey}>
                {position(r.callKind!, r.range.line)} ·{" "}
                {o.effectiveFields.join(", ")}
              </Text>
            );
          })}
          <Text>
            {t["com.myoxus.editor.mermaid.c4-records"]({
              count: new Intl.NumberFormat(t.language).format(records.length),
            })}
          </Text>
          {records.map((o) => (
            <Stack key={o.sourceKey}>
              <C4RelationshipRecordControl
                props={props}
                recordKey={o.sourceKey}
              />
              <Text>
                {t["com.myoxus.editor.mermaid.c4-record-effects"]({
                  fields: o.effectiveFields.join(", "),
                })}
              </Text>
            </Stack>
          ))}
        </Stack>
      </Scrollable.Viewport>
      {(prepared.diagnostic && !prepared.collision) ||
      d.diagnostic ||
      preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand && prepared.draft ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("reconnectC4Relationship", [
                prepared.draft!,
                true,
              ])
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
