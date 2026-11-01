// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  ConfirmModal,
  MyoxusText,
  Button,
  Checkbox,
  Group,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  CLASS_RELATION_PRESETS,
  classRelationSemantics,
  mermaidMessages as m,
  type ClassReactHostProps,
  type MermaidClassRelation,
  type ClassMarker,
} from "@virgultum/block-mermaid";
import { changedClassFields, useClassDraft } from "./drafts";
export function ClassRelationForm({
  props,
  relation,
  onClose,
}: {
  props: ClassReactHostProps;
  relation?: MermaidClassRelation;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const t = useI18n(),
    classes = props.model.nodes.filter((n) => n.kind === "class");
  const initial = {
    fromSourceId:
      relation?.fromSourceId ??
      classes.find((n) => n.sourceKey === props.selectedKeys[0])?.sourceId ??
      classes[0]?.sourceId ??
      "",
    toSourceId:
      relation?.toSourceId ??
      classes.find((n) => n.sourceKey === props.selectedKeys[1])?.sourceId ??
      classes[1]?.sourceId ??
      classes[0]?.sourceId ??
      "",
    fromCardinality: relation?.fromCardinality ?? "",
    toCardinality: relation?.toCardinality ?? "",
    fromMarker: relation?.fromMarker ?? ("none" as ClassMarker),
    toMarker: relation?.toMarker ?? ("none" as ClassMarker),
    lineStyle: relation?.lineStyle ?? ("solid" as const),
    label: relation?.label ?? "",
    preset: "",
    reverse: false,
  };
  const d = useClassDraft(initial, props),
    v = d.value;
  const markers = [
    { value: "none", label: m.optionDefault() },
    { value: "arrow", label: m.optionArrow() },
    { value: "inheritance", label: m.optionInheritance() },
    { value: "aggregation", label: m.classAggregation() },
    { value: "composition", label: m.optionComposition() },
    { value: "lollipop", label: m.classLollipop() },
  ];
  const presets = [
    { value: "association", label: m.optionAssociation() },
    { value: "directed", label: m.optionArrow() },
    { value: "inheritance", label: m.optionInheritance() },
    { value: "realization", label: m.classRealization() },
    { value: "dependency", label: m.optionDependency() },
    { value: "aggregation", label: m.classAggregation() },
    { value: "composition", label: m.optionComposition() },
    { value: "lollipop", label: m.classLollipop() },
  ];
  return (
    <Stack>
      <Select
        label={m.selectedEdgeType()}
        value={v.preset}
        data={[{ value: "", label: m.optionDefault() }, ...presets]}
        disabled={props.readonly}
        onChange={(value) => {
          d.set("preset", value);
          if (value) {
            const semantics = classRelationSemantics(
              CLASS_RELATION_PRESETS[
                value as keyof typeof CLASS_RELATION_PRESETS
              ],
            );
            d.set("fromMarker", semantics.fromMarker);
            d.set("toMarker", semantics.toMarker);
            d.set("lineStyle", semantics.lineStyle);
          }
        }}
      />
      <MyoxusTextInput
        autoFocus
        label={m.classFirstEnd()}
        value={v.fromSourceId}
        disabled={props.readonly}
        onChange={(value) => d.set("fromSourceId", value)}
      />
      <Select
        label={`${m.classFirstEnd()} · ${m.selectedEdgeType()}`}
        data={markers}
        value={v.fromMarker}
        disabled={props.readonly}
        onChange={(value) => d.set("fromMarker", value as ClassMarker)}
      />
      <MyoxusTextInput
        label={`${m.classFirstEnd()} · ${m.classCardinality()}`}
        value={v.fromCardinality}
        disabled={props.readonly}
        onChange={(value) => d.set("fromCardinality", value)}
      />
      <MyoxusTextInput
        label={m.classSecondEnd()}
        value={v.toSourceId}
        disabled={props.readonly}
        onChange={(value) => d.set("toSourceId", value)}
      />
      <Select
        label={`${m.classSecondEnd()} · ${m.selectedEdgeType()}`}
        data={markers}
        value={v.toMarker}
        disabled={props.readonly}
        onChange={(value) => d.set("toMarker", value as ClassMarker)}
      />
      <MyoxusTextInput
        label={`${m.classSecondEnd()} · ${m.classCardinality()}`}
        value={v.toCardinality}
        disabled={props.readonly}
        onChange={(value) => d.set("toCardinality", value)}
      />
      <Select
        label={m.edgeStyleLabel()}
        data={[
          { value: "solid", label: m.optionSolid() },
          { value: "dashed", label: m.optionDashedLink() },
        ]}
        value={v.lineStyle}
        disabled={props.readonly}
        onChange={(value) => d.set("lineStyle", value as typeof v.lineStyle)}
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
      />
      {relation ? (
        <Checkbox
          label={m.classReverse()}
          checked={v.reverse}
          disabled={props.readonly}
          onChange={(event) => d.set("reverse", event.currentTarget.checked)}
        />
      ) : null}
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      {!props.readonly ? (
        <Group>
          <Button
            onClick={() => {
              const changes = changedClassFields(initial, v);
              const result = relation
                ? d.commit("editClassRelation", [
                    relation.id,
                    {
                      ...changes,
                      preset: undefined,
                      fromMarker: v.fromMarker,
                      toMarker: v.toMarker,
                      lineStyle: v.lineStyle,
                    },
                  ])
                : d.commit("connectClasses", [
                    {
                      fromSourceId: v.fromSourceId,
                      toSourceId: v.toSourceId,
                      fromCardinality: v.fromCardinality,
                      toCardinality: v.toCardinality,
                      label: v.label,
                      fromMarker: v.fromMarker,
                      toMarker: v.toMarker,
                      lineStyle: v.lineStyle,
                    },
                  ]);
              if (!result.diagnostic) onClose();
            }}
          >
            {t["com.myoxus.editCollection.save"]()}
          </Button>
          {relation ? (
            <Button onClick={() => setDeleting(true)}>
              {m.visualDelete()}
            </Button>
          ) : null}
        </Group>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!relation) return;
          const result = d.commit("deleteClassRelation", [relation.id]);
          if (!result.diagnostic) {
            setDeleting(false);
            onClose();
          }
        }}
      >
        <Stack>
          {relation
            ? props
                .getImpact({ kind: "relation", key: relation.id })
                .records.map((record) => (
                  <MyoxusText key={record.id}>{record.label}</MyoxusText>
                ))
            : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
