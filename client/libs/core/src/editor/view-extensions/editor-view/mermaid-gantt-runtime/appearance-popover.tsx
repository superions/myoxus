// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Box,
  Button,
  Checkbox,
  ColorInput,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Select,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import {
  GANTT_CONFIG_NUMBER_FIELDS,
  mermaidMessages as messages,
  readMermaidGanttDefaults,
  renderMermaidSvg,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";
import { useGanttOptionDrafts } from "./option-drafts";

const TICK_UNITS = [
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
];

/** Native appearance is document content, never theme overrides on editor chrome. */
export function GanttAppearancePopover({
  props,
  onClose,
  optionsPortalTarget,
}: {
  readonly props: MermaidGanttReactHostProps;
  readonly onClose: () => void;
  readonly optionsPortalTarget: string;
}) {
  const draft = useGanttOptionDrafts(props.model);
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [svg, setSvg] = useState("");
  const [renderedSource, setRenderedSource] = useState<string>();
  const [defaultsError, setDefaultsError] = useState(false);
  const [renderError, setRenderError] = useState(false);
  useEffect(() => {
    let active = true;
    readMermaidGanttDefaults()
      .then((value) => {
        if (active) setDefaults(value);
      })
      .catch(() => {
        if (active) setDefaultsError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const tick = draft.value("tickInterval");
  const tickParts =
    /^(\d+)\s*(millisecond|second|minute|hour|day|week|month)$/.exec(
      tick.trim(),
    );
  const tickValid =
    !tick.trim() ||
    /^[1-9]\d*(millisecond|second|minute|hour|day|week|month)$/.test(
      tick.trim(),
    );
  const today = draft.value("todayMarker");
  const declarations =
    today === "off"
      ? []
      : today
          .split(",")
          .filter(Boolean)
          .map((value) => {
            const colon = value.indexOf(":");
            return {
              property: value.slice(0, colon).trim(),
              value: value.slice(colon + 1).trim(),
            };
          });
  const styleValid = declarations.every((item) =>
    Boolean(
      item.property &&
      item.value &&
      !/[\r\n;,]/.test(item.value) &&
      CSS.supports(item.property, item.value),
    ),
  );
  const next = draft.commands.filter(
    (command) =>
      command.type !== "option.set" ||
      !["tickInterval", "todayMarker"].includes(command.name) ||
      (command.name === "tickInterval" ? tickValid : styleValid),
  );
  const preview = next.length ? props.onPreviewCommand(next) : null;
  const effective = preview?.model ?? props.model;
  const previewSource = preview?.changed
    ? preview.source
    : props.model.sourceDocument.source;
  useEffect(() => {
    let active = true;
    setRenderError(false);
    renderMermaidSvg(previewSource, { idPrefix: "myoxus-gantt-appearance" })
      .then((result) => {
        if (active) {
          setSvg(result.svg);
          setRenderedSource(previewSource);
          setRenderError(false);
        }
      })
      .catch(() => {
        if (active) {
          setSvg("");
          setRenderedSource(undefined);
          setRenderError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [previewSource]);
  const updateStyle = (
    index: number,
    field: "property" | "value",
    value: string,
  ) => {
    const next = declarations.map((item, position) =>
      position === index ? { ...item, [field]: value } : item,
    );
    draft.setValue(
      "todayMarker",
      next.map((item) => `${item.property}:${item.value}`).join(","),
    );
  };
  // A successful older render must never validate a newer command draft.
  const canApply =
    !props.readonly &&
    tickValid &&
    styleValid &&
    !renderError &&
    !defaultsError &&
    renderedSource === previewSource &&
    Boolean(preview?.changed);
  return (
    <Stack p="sm" w={340}>
      <MyoxusText typographySlot="dense-label">
        {messages.visualAppearance()}
      </MyoxusText>
      <Accordion multiple defaultValue={["axis"]}>
        <AccordionItem value="axis">
          <AccordionControl>{messages.ganttAxisFormat()}</AccordionControl>
          <AccordionPanel>
            <Stack>
              {draft.controls(
                "axisFormat",
                messages.ganttAxisFormat(),
                effective.axis.axisFormat ?? String(defaults.axisFormat ?? "—"),
              )}
              <MyoxusTextInput
                label={messages.ganttAxisFormat()}
                value={draft.value("axisFormat")}
                onChange={(value) => draft.setValue("axisFormat", value)}
              />
              {draft.controls(
                "tickInterval",
                messages.ganttTickInterval(),
                effective.axis.tickInterval ??
                  String(defaults.tickInterval ?? "—"),
              )}
              <NumberInput
                label={messages.ganttTickInterval()}
                min={1}
                allowDecimal={false}
                value={
                  tickParts
                    ? Number(tickParts[1])
                    : tick
                      ? tick.split(/\s+/)[0]
                      : ""
                }
                onChange={(value) =>
                  value === ""
                    ? draft.reset("tickInterval")
                    : draft.setValue(
                        "tickInterval",
                        `${value}${tickParts?.[2] ?? "day"}`,
                      )
                }
                error={
                  tickValid
                    ? undefined
                    : messages.ganttDiagnosticInvalidSchedule()
                }
              />
              <Select
                comboboxProps={{
                  withinPortal: true,
                  portalProps: { target: optionsPortalTarget },
                }}
                label="tickInterval"
                data={TICK_UNITS.map((value) => ({ value, label: value }))}
                value={tickParts?.[2] ?? "day"}
                onChange={(value) => {
                  if (value)
                    draft.setValue(
                      "tickInterval",
                      `${tickParts?.[1] ?? "1"}${value}`,
                    );
                }}
              />
              {draft.controls(
                "topAxis",
                messages.ganttTopAxis(),
                String(effective.axis.topAxis ?? defaults.topAxis ?? false),
              )}
              <Checkbox
                label={messages.ganttTopAxis()}
                checked={draft.value("topAxis", "false") !== "false"}
                onChange={(event) =>
                  event.target.checked
                    ? draft.setValue("topAxis", "")
                    : draft.reset("topAxis")
                }
              />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="today">
          <AccordionControl>{messages.ganttTodayMarker()}</AccordionControl>
          <AccordionPanel>
            <Stack>
              {draft.controls(
                "todayMarker",
                messages.ganttTodayMarker(),
                effective.axis.todayMarker ?? "—",
              )}
              <Checkbox
                label="off"
                checked={today === "off"}
                onChange={(event) =>
                  event.target.checked
                    ? draft.setValue("todayMarker", "off")
                    : draft.reset("todayMarker")
                }
              />
              {declarations.map((item, index) => (
                <Stack key={index} gap="xs">
                  <MyoxusTextInput
                    label={`${messages.property()} · todayMarker CSS`}
                    value={item.property}
                    onChange={(value) => updateStyle(index, "property", value)}
                  />
                  {item.property === "stroke-width" ||
                  item.property === "opacity" ? (
                    <NumberInput
                      label={item.property}
                      value={item.value}
                      min={0}
                      max={item.property === "opacity" ? 1 : undefined}
                      onChange={(value) =>
                        updateStyle(index, "value", String(value))
                      }
                    />
                  ) : item.property === "stroke-linecap" ? (
                    <Select
                      comboboxProps={{
                        withinPortal: true,
                        portalProps: { target: optionsPortalTarget },
                      }}
                      label={item.property}
                      data={["butt", "round", "square"].map((value) => ({
                        value,
                        label: value,
                      }))}
                      value={item.value}
                      onChange={(value) => {
                        if (value) updateStyle(index, "value", value);
                      }}
                    />
                  ) : item.property === "stroke" ? (
                    <ColorInput
                      label="stroke"
                      value={item.value}
                      onChange={(value) => updateStyle(index, "value", value)}
                    />
                  ) : (
                    <MyoxusTextInput
                      label={
                        item.property || `${messages.value()} · todayMarker CSS`
                      }
                      value={item.value}
                      onChange={(value) => updateStyle(index, "value", value)}
                    />
                  )}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      draft.setValue(
                        "todayMarker",
                        declarations
                          .filter((_, position) => position !== index)
                          .map((item) => `${item.property}:${item.value}`)
                          .join(","),
                      )
                    }
                  >
                    {messages.structuredRemoveEntry()}
                  </Button>
                </Stack>
              ))}
              <Button
                variant="ghost"
                onClick={() =>
                  draft.setValue(
                    "todayMarker",
                    [...declarations, { property: "stroke-width", value: "2" }]
                      .map((item) => `${item.property}:${item.value}`)
                      .join(","),
                  )
                }
              >
                {messages.structuredAddEntry()}
              </Button>
            </Stack>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="config">
          <AccordionControl>gantt config</AccordionControl>
          <AccordionPanel>
            <Stack>
              {draft.controls(
                "displayMode",
                "displayMode",
                effective.displayMode ?? "normal",
              )}
              <Select
                comboboxProps={{
                  withinPortal: true,
                  portalProps: { target: optionsPortalTarget },
                }}
                label="displayMode"
                data={[
                  { label: "normal", value: "" },
                  { label: "compact", value: "compact" },
                ]}
                value={draft.value("displayMode")}
                onChange={(value) => {
                  if (value !== null) draft.setValue("displayMode", value);
                }}
              />
              {draft.controls(
                "useMaxWidth",
                messages.ganttFitToWidth(),
                String(effective.useMaxWidth ?? defaults.useMaxWidth ?? true),
              )}
              <Checkbox
                label={messages.ganttFitToWidth()}
                checked={draft.value("useMaxWidth", "true") !== "false"}
                onChange={(event) =>
                  draft.setValue("useMaxWidth", String(event.target.checked))
                }
              />
              {GANTT_CONFIG_NUMBER_FIELDS.map((name) => (
                <Stack key={name} gap="xs">
                  {draft.controls(
                    name,
                    name,
                    String(
                      effective.configOccurrences.findLast(
                        (item) => item.field === name,
                      )?.resolvedValue ??
                        defaults[name] ??
                        "—",
                    ),
                  )}
                  <NumberInput
                    label={name}
                    value={draft.value(name)}
                    min={0}
                    allowDecimal={name !== "numberSectionStyles"}
                    onChange={(value) =>
                      value === ""
                        ? draft.reset(name)
                        : draft.setValue(name, String(value))
                    }
                  />
                </Stack>
              ))}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      {renderedSource === previewSource ? (
        svg ? (
          <Scrollable.Viewport
            autosize
            maxHeight="popover"
            scrollbars="xy"
            aria-label={messages.sourcePreviewLabel()}
          >
            <Box dangerouslySetInnerHTML={{ __html: svg }} />
          </Scrollable.Viewport>
        ) : (
          <MyoxusText typographySlot="caption">
            {messages.previewEmpty()}
          </MyoxusText>
        )
      ) : !renderError ? (
        <MyoxusText typographySlot="caption">{messages.loading()}</MyoxusText>
      ) : null}
      {draft.conflicted ||
      defaultsError ||
      renderError ||
      !styleValid ||
      (preview && !preview.changed && preview.diagnosis !== "no-change") ? (
        <MyoxusText tone="danger" typographySlot="caption">
          {draft.conflicted
            ? messages.ganttDiagnosticConflict()
            : messages.ganttDiagnosticInvalidSchedule()}
        </MyoxusText>
      ) : null}
      <Group justify="flex-end">
        <Button
          variant="ghost"
          onClick={() => {
            draft.cancel();
            onClose();
          }}
        >
          {messages.cancel()}
        </Button>
        <Button
          variant="primary"
          disabled={!canApply}
          onClick={() => {
            if (canApply && preview?.changed && props.onCommand(next).changed)
              onClose();
          }}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
