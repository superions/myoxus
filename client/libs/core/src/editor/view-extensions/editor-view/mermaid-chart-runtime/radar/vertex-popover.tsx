// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  dataRadarValueStep,
  Group,
  localizedChartNumber,
  MyoxusSelect,
  MyoxusText,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidRadarCommand,
  MermaidRadarCurve,
  MermaidRadarReactHostProps,
  MermaidRadarVertex,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

import { uniqueRadarDiagnostics } from "./diagnostics";

export function MermaidRadarVertexPopover({
  curve,
  onApply,
  onClose,
  onDelete,
  props,
  vertex,
}: {
  readonly curve: MermaidRadarCurve;
  readonly onApply: (commands: readonly MermaidRadarCommand[]) => boolean;
  readonly onClose: () => void;
  readonly onDelete: () => void;
  readonly props: MermaidRadarReactHostProps;
  readonly vertex: MermaidRadarVertex;
}) {
  const [value, setValue] = useState<number | string>(vertex.value ?? "");
  const [axisId, setAxisId] = useState(vertex.axisId);
  useEffect(() => {
    setValue(vertex.value ?? "");
    setAxisId(vertex.axisId);
  }, [vertex.axisId, vertex.id, vertex.value]);
  const commands = [
    ...(curve.sourceForm === "detailed" &&
    vertex.entryId &&
    axisId !== vertex.axisId
      ? [
          {
            axisId,
            entryId: vertex.entryId,
            type: "vertex.reference" as const,
          },
        ]
      : []),
    ...(typeof value === "number" && value !== vertex.value
      ? vertex.entryId
        ? [
            {
              entryId: vertex.entryId,
              type: "vertex.value" as const,
              value,
            },
          ]
        : [
            {
              axisId: vertex.axisId,
              curveId: curve.id,
              type: "vertex.repair" as const,
              value,
            },
          ]
      : []),
  ];
  const valid = commands.length > 0 && props.onPreviewCommand(commands).changed;
  const axis = props.model.axes.find(
    (candidate) => candidate.id === vertex.axisId,
  );
  const axisLabel = axis
    ? props.model.axes.filter((candidate) => candidate.label === axis.label)
        .length > 1
      ? `${axis.label} · ${axis.name}`
      : axis.label
    : "";
  const diagnostics = uniqueRadarDiagnostics(
    props.model.diagnostics.filter(
      (diagnostic) =>
        diagnostic.objectId === vertex.id ||
        diagnostic.objectId === vertex.entryId ||
        (vertex.value === undefined &&
          (diagnostic.objectId === curve.id ||
            diagnostic.objectId === curve.sourceRecordId)),
    ),
  );
  const minimum = props.model.options.effective.minimum;
  const maximum = props.model.options.effective.maximum ?? minimum + 1;
  const sourceStep = vertex.entryId
    ? curve.entries.find((entry) => entry.id === vertex.entryId)?.precision
    : undefined;
  const step = dataRadarValueStep(
    sourceStep,
    minimum,
    maximum,
    props.model.options.effective.ticks,
  );
  return (
    <Stack gap="xs">
      {diagnostics.map((diagnostic) => (
        <Alert color="myoxusError" key={diagnostic.id} variant="light">
          {diagnostic.message ?? props.labels.invalid}
        </Alert>
      ))}
      <MyoxusText typographySlot="caption">
        {curve.label} · {axisLabel}
      </MyoxusText>
      <NumberInput
        aria-label={props.labels.value}
        autoFocus
        label={props.labels.value}
        min={0}
        onChange={setValue}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && valid) onApply(commands);
        }}
        value={value}
      />
      <MyoxusText typographySlot="caption">
        {props.labels.valueStep(
          localizedChartNumber(step),
          localizedChartNumber(step * 10),
        )}
      </MyoxusText>
      {curve.sourceForm === "detailed" && vertex.entryId ? (
        <MyoxusSelect
          aria-label={props.labels.axis}
          data={props.model.axes.map((axis) => ({
            label:
              props.model.axes.filter(
                (candidate) => candidate.label === axis.label,
              ).length > 1
                ? `${axis.label} · ${axis.name}`
                : axis.label,
            value: axis.id,
          }))}
          onChange={(next) => {
            if (!next) return;
            setAxisId(next);
          }}
          value={axisId}
        />
      ) : null}
      <Group justify="space-between">
        {vertex.entryId ? (
          <Button color="myoxusError" onClick={onDelete} variant="plain">
            {props.labels.delete}
          </Button>
        ) : (
          <span />
        )}
        <Group>
          <Button onClick={onClose} variant="plain">
            {props.labels.cancel}
          </Button>
          <Button disabled={!valid} onClick={() => valid && onApply(commands)}>
            {props.labels.apply}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
