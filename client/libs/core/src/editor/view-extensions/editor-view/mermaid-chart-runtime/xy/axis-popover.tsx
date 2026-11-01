// SPDX-License-Identifier: AGPL-3.0-or-later

import { SettingsIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  IconButton,
  localizedChartNumber,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import type {
  MermaidXyCommand,
  MermaidXyReactHostProps,
} from "@virgultum/block-mermaid";
import { mermaidXyTextFitsForm } from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

function finiteAxisValue(value: number | string) {
  return (
    (typeof value === "number" || value.trim() !== "") &&
    Number.isFinite(Number(value))
  );
}

export function MermaidXyAxisPopover({
  onApply,
  onOpenedChange,
  opened,
  props,
}: {
  readonly onApply: (commands: readonly MermaidXyCommand[]) => boolean;
  readonly onOpenedChange: (opened: boolean) => void;
  readonly opened: boolean;
  readonly props: MermaidXyReactHostProps;
}) {
  const sourceHashRef = useRef(props.model.sourceHash);
  const [xTitle, setXTitle] = useState(props.model.xAxis.title);
  const [yTitle, setYTitle] = useState(props.model.yAxis.title);
  const [minimum, setMinimum] = useState<number | string>(
    props.model.yAxis.minimum,
  );
  const [maximum, setMaximum] = useState<number | string>(
    props.model.yAxis.maximum,
  );
  const currentXKind =
    props.model.xAxis.sourceForm === "band" ||
    props.model.xAxis.sourceForm === "linear"
      ? props.model.xAxis.sourceForm
      : "auto";
  const [xKind, setXKind] = useState<"auto" | "band" | "linear">(currentXKind);
  const [yAutomatic, setYAutomatic] = useState(
    !props.model.yAxis.rangeExplicit,
  );
  const [xMinimum, setXMinimum] = useState<number | string>(
    props.model.xAxis.effectiveMinimum,
  );
  const [xMaximum, setXMaximum] = useState<number | string>(
    props.model.xAxis.effectiveMaximum,
  );
  const [conversionConfirmed, setConversionConfirmed] = useState(false);
  const axisDiagnostics = props.model.diagnostics.filter(
    (diagnostic) =>
      diagnostic.role === "x-axis" || diagnostic.role === "y-axis",
  );
  const axisActionLabel = axisDiagnostics[0]
    ? `${props.labels.axes}: ${axisDiagnostics[0].message}`
    : props.labels.axes;
  const requiredBandCount = Math.max(
    1,
    ...props.model.plots.map((plot) => plot.points.length),
  );
  const [bandCategories, setBandCategories] = useState<string[]>(() =>
    Array.from(
      { length: requiredBandCount },
      (_, index) => props.model.xAxis.categories[index]?.label ?? "",
    ),
  );
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    onOpenedChange(false);
  }, [onOpenedChange, props.model.sourceHash]);
  useEffect(() => {
    if (opened) return;
    setXTitle(props.model.xAxis.title);
    setYTitle(props.model.yAxis.title);
    setMinimum(props.model.yAxis.minimum);
    setMaximum(props.model.yAxis.maximum);
    setXKind(currentXKind);
    setYAutomatic(!props.model.yAxis.rangeExplicit);
    setXMinimum(props.model.xAxis.effectiveMinimum);
    setXMaximum(props.model.xAxis.effectiveMaximum);
    setConversionConfirmed(false);
    setBandCategories(
      Array.from(
        { length: requiredBandCount },
        (_, index) => props.model.xAxis.categories[index]?.label ?? "",
      ),
    );
  }, [
    currentXKind,
    opened,
    props.model.sourceHash,
    props.model.xAxis.categories,
    props.model.xAxis.effectiveMaximum,
    props.model.xAxis.effectiveMinimum,
    props.model.xAxis.title,
    props.model.yAxis.maximum,
    props.model.yAxis.minimum,
    props.model.yAxis.rangeExplicit,
    props.model.yAxis.title,
    requiredBandCount,
  ]);
  const min = Number(minimum);
  const max = Number(maximum);
  const xMin = Number(xMinimum);
  const xMax = Number(xMaximum);
  const conversionNeedsConfirmation =
    currentXKind === "band" && xKind !== "band";
  const bandCategoriesInvalid =
    xKind === "band" &&
    currentXKind !== "band" &&
    bandCategories.some(
      (category) =>
        !category.trim() || !mermaidXyTextFitsForm(category.trim(), "quoted"),
    );
  const xTitleInvalid =
    Boolean(xTitle.trim()) &&
    !mermaidXyTextFitsForm(
      xTitle.trim(),
      props.model.xAxis.titleForm ?? "plain",
    );
  const yTitleInvalid =
    Boolean(yTitle.trim()) &&
    !mermaidXyTextFitsForm(
      yTitle.trim(),
      props.model.yAxis.titleForm ?? "plain",
    );
  const yRangeInvalid =
    !yAutomatic &&
    (!finiteAxisValue(minimum) || !finiteAxisValue(maximum) || min >= max);
  const xRangeInvalid =
    xKind === "linear" &&
    (!finiteAxisValue(xMinimum) || !finiteAxisValue(xMaximum) || xMin >= xMax);
  const invalid =
    yRangeInvalid ||
    xRangeInvalid ||
    (conversionNeedsConfirmation && !conversionConfirmed) ||
    bandCategoriesInvalid ||
    xTitleInvalid ||
    yTitleInvalid;
  const plotLabel = (plot: (typeof props.model.plots)[number]) =>
    plot.titleExplicit
      ? plot.title
      : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`;
  const autoValues = props.model.plots.flatMap((plot) =>
    plot.points.map((point) => point.value),
  );
  const autoYMinimum = autoValues.length ? Math.min(...autoValues) : 0;
  const autoYMaximum = autoValues.length
    ? Math.max(...autoValues) === autoYMinimum
      ? autoYMinimum + 1
      : Math.max(...autoValues)
    : 1;
  const linearPositions = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      count <= 1 ? xMin : xMin + (index / (count - 1)) * (xMax - xMin),
    )
      .map(localizedChartNumber)
      .join(", ");
  const apply = () => {
    const commands: MermaidXyCommand[] = [];
    if (xTitle !== props.model.xAxis.title)
      commands.push({ axis: "x", title: xTitle, type: "axis.title" });
    if (yTitle !== props.model.yAxis.title)
      commands.push({ axis: "y", title: yTitle, type: "axis.title" });
    if (yAutomatic !== !props.model.yAxis.rangeExplicit)
      commands.push(
        yAutomatic
          ? { automatic: true, axis: "y", type: "axis.range" }
          : {
              axis: "y",
              maximum: max,
              minimum: min,
              type: "axis.range",
            },
      );
    else if (
      !yAutomatic &&
      (min !== props.model.yAxis.minimum || max !== props.model.yAxis.maximum)
    )
      commands.push({
        axis: "y",
        minimum: min,
        maximum: max,
        type: "axis.range",
      });
    if (xKind !== currentXKind)
      commands.push({
        categories:
          xKind === "band"
            ? bandCategories.map((label) => ({ label }))
            : undefined,
        confirmCategoryIds: conversionNeedsConfirmation
          ? props.model.xAxis.categories.map((category) => category.id)
          : undefined,
        kind: xKind,
        type: "axis.x-model",
      });
    if (
      xKind === "linear" &&
      (xMin !== props.model.xAxis.effectiveMinimum ||
        xMax !== props.model.xAxis.effectiveMaximum)
    )
      commands.push({
        axis: "x",
        minimum: xMin,
        maximum: xMax,
        type: "axis.range",
      });
    if (commands.length === 0 || onApply(commands)) onOpenedChange(false);
  };
  return (
    <Popover onChange={onOpenedChange} opened={opened} returnFocus trapFocus>
      <PopoverTarget>
        <IconButton
          aria-label={axisActionLabel}
          aria-pressed={opened}
          icon={<SettingsIcon />}
          onClick={() => onOpenedChange(!opened)}
          tooltip={axisActionLabel}
          variant={opened || axisDiagnostics.length > 0 ? "solid" : "plain"}
        />
      </PopoverTarget>
      <PopoverContent>
        <Stack gap="xs">
          {axisDiagnostics.map((diagnostic) => (
            <Alert
              color={
                diagnostic.severity === "error"
                  ? "myoxusError"
                  : "myoxusWarning"
              }
              key={diagnostic.id}
              role="status"
              variant="light"
            >
              {diagnostic.message}
            </Alert>
          ))}
          <MyoxusTextInput
            aria-label={props.labels.x}
            error={xTitleInvalid ? props.labels.invalid : undefined}
            onChange={setXTitle}
            value={xTitle}
          />
          <MyoxusTextInput
            aria-label={props.labels.y}
            error={yTitleInvalid ? props.labels.invalid : undefined}
            onChange={setYTitle}
            value={yTitle}
          />
          <MyoxusSegmentedControl
            data={[
              { label: props.labels.autoAxis, value: "auto" },
              { label: props.labels.bandAxis, value: "band" },
              { label: props.labels.linearAxis, value: "linear" },
            ]}
            onChange={(value) => {
              setXKind(value as "auto" | "band" | "linear");
              setConversionConfirmed(false);
            }}
            value={xKind}
          />
          {xKind === "linear" ? (
            <Group grow>
              <NumberInput
                aria-label={props.labels.xAxisStart}
                error={xRangeInvalid ? props.labels.invalid : undefined}
                onChange={setXMinimum}
                value={xMinimum}
              />
              <NumberInput
                aria-label={props.labels.xAxisEnd}
                error={xRangeInvalid ? props.labels.invalid : undefined}
                onChange={setXMaximum}
                value={xMaximum}
              />
            </Group>
          ) : null}
          {xKind === "band" && currentXKind !== "band" ? (
            <Stack gap="xs">
              <Alert color="myoxusInfo" variant="light">
                <Stack gap="xs">
                  {props.model.plots.map((plot) => (
                    <MyoxusText key={plot.id}>
                      {props.labels.plotPointCount(
                        plotLabel(plot),
                        plot.points.length,
                      )}
                    </MyoxusText>
                  ))}
                </Stack>
              </Alert>
              {bandCategories.map((category, index) => (
                <MyoxusTextInput
                  aria-label={`${props.labels.category} ${index + 1}`}
                  error={
                    !category.trim() ||
                    !mermaidXyTextFitsForm(category.trim(), "quoted")
                      ? props.labels.invalid
                      : undefined
                  }
                  key={index}
                  onChange={(value) =>
                    setBandCategories((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? value : item,
                      ),
                    )
                  }
                  value={category}
                />
              ))}
            </Stack>
          ) : null}
          {conversionNeedsConfirmation ? (
            <Alert color="myoxusWarning" variant="light">
              <Checkbox
                checked={conversionConfirmed}
                label={props.labels.axisConversionImpact}
                onChange={(event) =>
                  setConversionConfirmed(event.currentTarget.checked)
                }
              />
            </Alert>
          ) : null}
          {xKind === "auto" ? (
            <Alert color="myoxusInfo" variant="light">
              {props.labels.autoXSource(
                props.model.plots[0]
                  ? plotLabel(props.model.plots[0])
                  : props.labels.plot,
                props.model.plots[0]?.points.length ?? 1,
              )}
            </Alert>
          ) : xKind === "linear" ? (
            <Alert color="myoxusInfo" variant="light">
              <Stack gap="xs">
                <MyoxusText>{props.labels.rangePreview(xMin, xMax)}</MyoxusText>
                {props.model.plots.map((plot) => (
                  <MyoxusText key={plot.id}>
                    {props.labels.plotPositions(
                      plotLabel(plot),
                      linearPositions(plot.points.length),
                    )}
                  </MyoxusText>
                ))}
              </Stack>
            </Alert>
          ) : null}
          <MyoxusSegmentedControl
            aria-label={props.labels.y}
            data={[
              { label: props.labels.autoAxis, value: "auto" },
              { label: props.labels.explicitRange, value: "range" },
            ]}
            layout="fluid"
            onChange={(value) => setYAutomatic(value === "auto")}
            value={yAutomatic ? "auto" : "range"}
          />
          {!yAutomatic ? (
            <Group grow>
              <NumberInput
                aria-label={props.labels.yAxisMinimum}
                error={yRangeInvalid ? props.labels.invalid : undefined}
                onChange={setMinimum}
                value={minimum}
              />
              <NumberInput
                aria-label={props.labels.yAxisMaximum}
                error={yRangeInvalid ? props.labels.invalid : undefined}
                onChange={setMaximum}
                value={maximum}
              />
            </Group>
          ) : (
            <Alert color="myoxusInfo" variant="light">
              {props.labels.rangePreview(autoYMinimum, autoYMaximum)}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={() => onOpenedChange(false)} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button disabled={invalid} onClick={apply}>
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
