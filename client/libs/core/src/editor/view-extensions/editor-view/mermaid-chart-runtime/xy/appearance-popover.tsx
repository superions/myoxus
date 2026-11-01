// SPDX-License-Identifier: AGPL-3.0-or-later

import { PaletteIcon } from "@myoxus/icons";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusSegmentedControl,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  DEFAULT_MERMAID_XY_CONFIG,
  type MermaidXyConfig,
  type MermaidXyReactHostProps,
  validMermaidXyConfigFieldValue,
} from "@virgultum/block-mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

const BOOLEAN_FIELDS = [
  "useMaxWidth",
  "showTitle",
  "showDataLabel",
  "showDataLabelOutsideBar",
] as const;
const NUMBER_FIELDS = [
  "width",
  "height",
  "titleFontSize",
  "titlePadding",
  "plotReservedSpacePercent",
] as const;
const SIZE_FIELDS = ["width", "height", "plotReservedSpacePercent"] as const;
const TITLE_FIELDS = ["titleFontSize", "titlePadding"] as const;
const AXIS_BOOLEAN_FIELDS = [
  "showLabel",
  "showTitle",
  "showTick",
  "showAxisLine",
] as const;
const AXIS_NUMBER_FIELDS = [
  "labelFontSize",
  "labelPadding",
  "titleFontSize",
  "titlePadding",
  "tickLength",
  "tickWidth",
  "axisLineWidth",
  "labelRotation",
] as const;

export function MermaidXyAppearancePopover({
  onApply,
  onOpenedChange,
  onPreview,
  opened,
  props,
}: {
  readonly onApply: (config: MermaidXyConfig) => boolean;
  readonly onOpenedChange: (opened: boolean) => void;
  readonly onPreview: (config: MermaidXyConfig | null) => void;
  readonly opened: boolean;
  readonly props: MermaidXyReactHostProps;
}) {
  const sourceHashRef = useRef(props.model.sourceHash);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const effective = useMemo<MermaidXyConfig>(
    () => ({
      ...DEFAULT_MERMAID_XY_CONFIG,
      ...props.model.config,
      chartOrientation: props.model.orientation,
      xAxis: {
        ...DEFAULT_MERMAID_XY_CONFIG.xAxis,
        ...props.model.config.xAxis,
      },
      yAxis: {
        ...DEFAULT_MERMAID_XY_CONFIG.yAxis,
        ...props.model.config.yAxis,
      },
    }),
    [props.model.config, props.model.orientation],
  );
  const [draft, setDraft] = useState<MermaidXyConfig>(effective);
  const [invalidValues, setInvalidValues] = useState<
    Record<string, number | string>
  >({});
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    onOpenedChange(false);
    onPreview(null);
  }, [onOpenedChange, onPreview, props.model.sourceHash]);
  useEffect(() => () => onPreviewRef.current(null), []);
  useEffect(() => {
    if (!opened) {
      setDraft(effective);
      setInvalidValues({});
    }
  }, [effective, opened]);
  const update = (next: MermaidXyConfig) => {
    setDraft(next);
    onPreview(next);
  };
  const setRoot = (field: string, value: unknown) =>
    update({ ...draft, [field]: value });
  const setAxis = (axis: "xAxis" | "yAxis", field: string, value: unknown) =>
    update({ ...draft, [axis]: { ...draft[axis], [field]: value } });
  const setNumber = (
    field: string,
    value: number | string,
    axis?: "xAxis" | "yAxis",
  ) => {
    const qualifiedField = axis ? `${axis}.${field}` : field;
    const parsed =
      typeof value === "string" && value.trim() === ""
        ? Number.NaN
        : Number(value);
    if (!validMermaidXyConfigFieldValue(qualifiedField, parsed)) {
      setInvalidValues((current) => ({
        ...current,
        [qualifiedField]: value,
      }));
      return;
    }
    setInvalidValues((current) => {
      const next = { ...current };
      delete next[qualifiedField];
      return next;
    });
    if (axis) setAxis(axis, field, parsed);
    else setRoot(field, parsed);
  };
  const labelFor = (field: string) =>
    props.labels.appearanceFields[
      field as keyof typeof props.labels.appearanceFields
    ];
  const numberControl = (field: (typeof NUMBER_FIELDS)[number]) => (
    <NumberInput
      key={field}
      label={labelFor(field)}
      error={field in invalidValues ? props.labels.invalid : undefined}
      max={field === "plotReservedSpacePercent" ? 99 : undefined}
      min={
        field === "titlePadding"
          ? 0
          : field === "plotReservedSpacePercent"
            ? 1
            : 1
      }
      onChange={(value) => setNumber(field, value)}
      value={invalidValues[field] ?? draft[field]}
    />
  );
  const axisControls = (axis: "xAxis" | "yAxis") => (
    <Stack gap="xs">
      {AXIS_BOOLEAN_FIELDS.map((field) => (
        <Switch
          checked={Boolean(draft[axis]?.[field])}
          key={field}
          onChange={(checked) => setAxis(axis, field, checked)}
        >
          {labelFor(field)}
        </Switch>
      ))}
      {AXIS_NUMBER_FIELDS.map((field) => (
        <NumberInput
          error={
            `${axis}.${field}` in invalidValues
              ? props.labels.invalid
              : undefined
          }
          key={field}
          label={labelFor(field)}
          min={
            field === "labelRotation"
              ? undefined
              : field === "labelPadding" || field === "titlePadding"
                ? 0
                : 1
          }
          onChange={(value) => setNumber(field, value, axis)}
          value={invalidValues[`${axis}.${field}`] ?? draft[axis]?.[field]}
        />
      ))}
    </Stack>
  );
  return (
    <Popover
      onChange={(next) => {
        onOpenedChange(next);
        if (!next) onPreview(null);
      }}
      opened={opened}
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.appearance}
          aria-pressed={opened}
          icon={<PaletteIcon />}
          onClick={() => onOpenedChange(!opened)}
          tooltip={props.labels.appearance}
          variant={opened ? "solid" : "plain"}
        />
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="popover">
          <Stack gap="xs">
            {props.model.headerOrientation &&
            props.model.config.chartOrientation &&
            props.model.headerOrientation !==
              props.model.config.chartOrientation ? (
              <Alert color="myoxusInfo" variant="light">
                {props.labels.orientationAuthority(
                  props.model.headerOrientation,
                  props.model.config.chartOrientation,
                )}
              </Alert>
            ) : null}
            {props.model.diagnostics
              .filter((diagnostic) => diagnostic.role === "config")
              .map((diagnostic) => (
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
            <MyoxusSegmentedControl
              aria-label={props.labels.appearance}
              data={[
                { label: props.labels.vertical, value: "vertical" },
                { label: props.labels.horizontal, value: "horizontal" },
              ]}
              layout="fluid"
              onChange={(value) => {
                const next = value as "horizontal" | "vertical";
                update({ ...draft, chartOrientation: next });
              }}
              value={draft.chartOrientation}
            />
            <Accordion defaultValue="size" variant="separated">
              <AccordionItem value="size">
                <AccordionControl>{labelFor("width")}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    <Switch
                      checked={Boolean(draft.useMaxWidth)}
                      onChange={(checked) => setRoot("useMaxWidth", checked)}
                    >
                      {labelFor("useMaxWidth")}
                    </Switch>
                    {SIZE_FIELDS.map(numberControl)}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="title">
                <AccordionControl>{labelFor("showTitle")}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    <Switch
                      checked={Boolean(draft.showTitle)}
                      onChange={(checked) => setRoot("showTitle", checked)}
                    >
                      {labelFor("showTitle")}
                    </Switch>
                    {TITLE_FIELDS.map(numberControl)}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="labels">
                <AccordionControl>{labelFor("showDataLabel")}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {BOOLEAN_FIELDS.filter(
                      (field) =>
                        field === "showDataLabel" ||
                        field === "showDataLabelOutsideBar",
                    ).map((field) => (
                      <Switch
                        checked={Boolean(draft[field])}
                        key={field}
                        onChange={(checked) => setRoot(field, checked)}
                      >
                        {labelFor(field)}
                      </Switch>
                    ))}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="x-axis">
                <AccordionControl>{props.labels.x}</AccordionControl>
                <AccordionPanel>{axisControls("xAxis")}</AccordionPanel>
              </AccordionItem>
              <AccordionItem value="y-axis">
                <AccordionControl>{props.labels.y}</AccordionControl>
                <AccordionPanel>{axisControls("yAxis")}</AccordionPanel>
              </AccordionItem>
            </Accordion>
            <Group justify="flex-end">
              <Button
                onClick={() => {
                  const reset = {
                    ...DEFAULT_MERMAID_XY_CONFIG,
                    xAxis: { ...DEFAULT_MERMAID_XY_CONFIG.xAxis },
                    yAxis: { ...DEFAULT_MERMAID_XY_CONFIG.yAxis },
                  };
                  setDraft(reset);
                  setInvalidValues({});
                  onPreview(reset);
                }}
                variant="plain"
              >
                {props.labels.reset}
              </Button>
              <Button
                onClick={() => {
                  onPreview(null);
                  onOpenedChange(false);
                }}
                variant="plain"
              >
                {props.labels.cancel}
              </Button>
              <Button
                disabled={Object.keys(invalidValues).length > 0}
                onClick={() => {
                  if (onApply(draft)) {
                    onPreview(null);
                    onOpenedChange(false);
                  }
                }}
              >
                {props.labels.apply}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
