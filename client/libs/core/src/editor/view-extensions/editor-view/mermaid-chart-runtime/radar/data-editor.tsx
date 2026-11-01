// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusSegmentedControl,
  MyoxusSelect,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import type {
  MermaidRadarCommandSelection,
  MermaidRadarReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

import { uniqueRadarDiagnostics } from "./diagnostics";

function radarMatrixObjectLabel(
  label: string,
  name: string,
  matchingLabels: number,
) {
  return label !== name || matchingLabels > 1 ? `${label} · ${name}` : label;
}

export function MermaidRadarAxisDraft({
  onApply,
  onCancel,
  props,
}: {
  readonly onApply: (
    name: string,
    label: string,
    values: Readonly<Record<string, number>>,
  ) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<(number | string)[]>(
    props.model.curves.map(() => ""),
  );
  const command = {
    label: label.trim(),
    name: name.trim(),
    type: "axis.add" as const,
    values: Object.fromEntries(
      props.model.curves.map((curve, index) => [
        curve.id,
        typeof values[index] === "number" ? values[index] : Number.NaN,
      ]),
    ),
  };
  const valid = props.onPreviewCommand(command).changed;
  return (
    <Stack gap="xs">
      <MyoxusTextInput
        aria-label={props.labels.name}
        autoFocus
        label={props.labels.name}
        onChange={setName}
        value={name}
      />
      <MyoxusTextInput
        aria-label={props.labels.label}
        label={props.labels.label}
        onChange={setLabel}
        value={label}
      />
      {props.model.curves.map((curve, index) => {
        const curveLabel = radarMatrixObjectLabel(
          curve.label,
          curve.name,
          props.model.curves.filter(
            (candidate) => candidate.label === curve.label,
          ).length,
        );
        return (
          <NumberInput
            aria-label={`${curveLabel}: ${props.labels.value}`}
            key={curve.id}
            label={`${curveLabel}: ${props.labels.value}`}
            min={0}
            onChange={(value) =>
              setValues((current) =>
                current.map((entry, candidate) =>
                  candidate === index ? value : entry,
                ),
              )
            }
            value={values[index]}
          />
        );
      })}
      <Group justify="flex-end">
        <Button onClick={onCancel} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button
          disabled={!valid}
          onClick={() => {
            if (!valid) return;
            onApply(command.name, command.label, command.values);
          }}
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidRadarCurveDraft({
  onApply,
  onCancel,
  props,
}: {
  readonly onApply: (
    name: string,
    label: string,
    form: "detailed" | "positional",
    values: Readonly<Record<string, number>>,
  ) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [form, setForm] = useState<"detailed" | "positional">("positional");
  const [values, setValues] = useState<(number | string)[]>(
    props.model.axes.map(() => ""),
  );
  const command = {
    form,
    label: label.trim(),
    name: name.trim(),
    type: "curve.add" as const,
    values: Object.fromEntries(
      props.model.axes.map((axis, index) => [
        axis.id,
        typeof values[index] === "number" ? values[index] : Number.NaN,
      ]),
    ),
  };
  const valid = props.onPreviewCommand(command).changed;
  return (
    <Stack gap="xs">
      <MyoxusTextInput
        aria-label={props.labels.name}
        autoFocus
        label={props.labels.name}
        onChange={setName}
        value={name}
      />
      <MyoxusTextInput
        aria-label={props.labels.label}
        label={props.labels.label}
        onChange={setLabel}
        value={label}
      />
      <MyoxusSegmentedControl
        aria-label={props.labels.curve}
        data={[
          { label: props.labels.positional, value: "positional" },
          { label: props.labels.detailed, value: "detailed" },
        ]}
        layout="fluid"
        onChange={(value) => setForm(value as "detailed" | "positional")}
        value={form}
      />
      {props.model.axes.map((axis, index) => {
        const axisLabel = radarMatrixObjectLabel(
          axis.label,
          axis.name,
          props.model.axes.filter((candidate) => candidate.label === axis.label)
            .length,
        );
        return (
          <NumberInput
            aria-label={`${axisLabel}: ${props.labels.value}`}
            key={axis.id}
            label={`${axisLabel}: ${props.labels.value}`}
            min={0}
            onChange={(value) =>
              setValues((current) =>
                current.map((entry, candidate) =>
                  candidate === index ? value : entry,
                ),
              )
            }
            value={values[index]}
          />
        );
      })}
      <Group justify="flex-end">
        <Button onClick={onCancel} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button
          disabled={!valid}
          onClick={() => {
            if (!valid) return;
            onApply(command.name, command.label, command.form, command.values);
          }}
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

function RadarValueCell({
  axisId,
  axisLabel,
  curveId,
  curveLabel,
  entryId,
  onApply,
  props,
  value,
}: {
  readonly axisId: string;
  readonly axisLabel: string;
  readonly curveId: string;
  readonly curveLabel: string;
  readonly entryId?: string;
  readonly onApply: (
    axisId: string,
    curveId: string,
    entryId: string | undefined,
    value: number,
  ) => void;
  readonly props: MermaidRadarReactHostProps;
  readonly value?: number;
}) {
  const [draft, setDraft] = useState<number | string>(value ?? "");
  useEffect(() => setDraft(value ?? ""), [entryId, value]);
  const command =
    typeof draft === "number"
      ? entryId
        ? ({ entryId, type: "vertex.value", value: draft } as const)
        : ({ axisId, curveId, type: "vertex.repair", value: draft } as const)
      : null;
  const valid = Boolean(command && props.onPreviewCommand(command).changed);
  const apply = () => {
    if (valid) onApply(axisId, curveId, entryId, draft as number);
  };
  const valueLabel = `${curveLabel} · ${axisLabel}: ${props.labels.value}`;
  return (
    <Group gap="xs" wrap="nowrap">
      <NumberInput
        aria-label={valueLabel}
        disabled={props.readonly}
        min={0}
        onChange={setDraft}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !valid) return;
          event.preventDefault();
          apply();
        }}
        value={draft}
      />
      {props.readonly ? null : (
        <Button
          aria-label={`${props.labels.apply}: ${curveLabel} · ${axisLabel}`}
          disabled={!valid || draft === value}
          onClick={apply}
          variant="plain"
        >
          {props.labels.apply}
        </Button>
      )}
    </Group>
  );
}

export function MermaidRadarDataEditor({
  onDeleteEntry,
  onReference,
  onSelect,
  onValue,
  props,
  selection,
}: {
  readonly onDeleteEntry: (entryId: string) => void;
  readonly onReference: (entryId: string, axisId: string) => void;
  readonly onSelect: (selection: MermaidRadarCommandSelection) => void;
  readonly onValue: (
    axisId: string,
    curveId: string,
    entryId: string | undefined,
    value: number,
  ) => void;
  readonly props: MermaidRadarReactHostProps;
  readonly selection?: MermaidRadarCommandSelection;
}) {
  const diagnosticMessages = uniqueRadarDiagnostics(
    props.model.diagnostics,
  ).flatMap((diagnostic) => (diagnostic.message ? [diagnostic.message] : []));
  return (
    <Stack gap="xs">
      {diagnosticMessages.length > 0 ? (
        <Alert color="myoxusWarning" variant="light">
          {diagnosticMessages.join(" · ")}
        </Alert>
      ) : null}
      <TableScrollContainer containInlineSize minWidth="max-content">
        <Table aria-label={props.labels.data} striped withTableBorder>
          <TableHeader>
            <TableRow>
              <TableHead>{props.labels.curve}</TableHead>
              {props.model.axes.map((axis) => (
                <TableHead key={axis.id}>
                  <Button
                    aria-label={radarMatrixObjectLabel(
                      axis.label,
                      axis.name,
                      props.model.axes.filter(
                        (candidate) => candidate.label === axis.label,
                      ).length,
                    )}
                    aria-pressed={
                      selection?.kind === "axis" && selection.id === axis.id
                    }
                    onClick={() => onSelect({ id: axis.id, kind: "axis" })}
                    variant="plain"
                  >
                    {axis.label}
                  </Button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.model.curves.map((curve) => (
              <TableRow key={curve.id}>
                <TableCell>
                  <Stack gap={0}>
                    <Button
                      aria-label={radarMatrixObjectLabel(
                        curve.label,
                        curve.name,
                        props.model.curves.filter(
                          (candidate) => candidate.label === curve.label,
                        ).length,
                      )}
                      aria-pressed={
                        selection?.kind === "curve" && selection.id === curve.id
                      }
                      onClick={() => onSelect({ id: curve.id, kind: "curve" })}
                      variant="plain"
                    >
                      {curve.label}
                    </Button>
                    <MyoxusText typographySlot="caption">
                      {curve.sourceForm === "detailed"
                        ? props.labels.detailed
                        : curve.sourceForm === "positional"
                          ? props.labels.positional
                          : props.labels.invalid}
                    </MyoxusText>
                    {curve.entries
                      .filter((entry) => entry.status !== "resolved")
                      .map((entry) => (
                        <Group gap="xs" key={entry.id} wrap="nowrap">
                          <MyoxusText typographySlot="caption">
                            {props.labels.sourceValue(
                              `${entry.axisName ?? "–"}: ${entry.value}`,
                            )}
                          </MyoxusText>
                          {props.readonly ||
                          curve.sourceForm !== "detailed" ? null : (
                            <MyoxusSelect
                              aria-label={props.labels.axis}
                              data={props.model.axes.map((axis) => ({
                                label: radarMatrixObjectLabel(
                                  axis.label,
                                  axis.name,
                                  props.model.axes.filter(
                                    (candidate) =>
                                      candidate.label === axis.label,
                                  ).length,
                                ),
                                value: axis.id,
                              }))}
                              onChange={(axisId) =>
                                axisId && onReference(entry.id, axisId)
                              }
                              value={entry.axisId ?? null}
                            />
                          )}
                          {props.readonly ? null : (
                            <Button
                              color="myoxusError"
                              onClick={() => onDeleteEntry(entry.id)}
                              variant="plain"
                            >
                              {props.labels.delete}
                            </Button>
                          )}
                        </Group>
                      ))}
                  </Stack>
                </TableCell>
                {props.model.axes.map((axis) => {
                  const vertex = curve.vertices.find(
                    (candidate) => candidate.axisId === axis.id,
                  );
                  return (
                    <TableCell
                      data-selected={
                        (selection?.kind === "vertex" &&
                          selection.id === vertex?.id) ||
                        undefined
                      }
                      key={axis.id}
                      onClick={() =>
                        vertex && onSelect({ id: vertex.id, kind: "vertex" })
                      }
                    >
                      <RadarValueCell
                        axisId={axis.id}
                        axisLabel={radarMatrixObjectLabel(
                          axis.label,
                          axis.name,
                          props.model.axes.filter(
                            (candidate) => candidate.label === axis.label,
                          ).length,
                        )}
                        curveId={curve.id}
                        curveLabel={radarMatrixObjectLabel(
                          curve.label,
                          curve.name,
                          props.model.curves.filter(
                            (candidate) => candidate.label === curve.label,
                          ).length,
                        )}
                        entryId={vertex?.entryId}
                        onApply={onValue}
                        props={props}
                        value={vertex?.value}
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScrollContainer>
    </Stack>
  );
}
