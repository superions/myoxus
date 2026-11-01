// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Scrollable,
  Select,
  Stack,
  TagsInput,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  TIMELINE_CONFIG_FIELDS,
  TIMELINE_EFFECTIVE_CONFIG_FIELDS,
  readMermaidTimelineDefaults,
  renderMermaidSvg,
  validTimelineConfigValue,
  type TimelineConfigField,
  type TimelineConfigValue,
  type TimelineCommand,
  type MermaidTimelineReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

/** Preview stages source commands; only Apply writes the opening-source transaction. */
export function TimelineAppearancePopover({
  props,
  onClose,
  optionsPortalTarget,
}: {
  readonly props: MermaidTimelineReactHostProps;
  readonly onClose: () => void;
  readonly optionsPortalTarget: string;
}) {
  const [basis, setBasis] = useState(props.model);
  const [direction, setDirection] = useState(basis.direction);
  const [draft, setDraft] = useState<
    Partial<Record<TimelineConfigField, TimelineConfigValue | undefined>>
  >({});
  const [extra, setExtra] = useState<TimelineConfigField>();
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [defaultsError, setDefaultsError] = useState(false);
  const [render, setRender] = useState<{
    source: string;
    svg?: string;
    error?: boolean;
  }>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    readMermaidTimelineDefaults()
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
  const commands: TimelineCommand[] = Object.entries(draft).map(
    ([field, value]) => ({
      type: "config",
      field: field as TimelineConfigField,
      value,
      statementId: basis.config.occurrences.findLast(
        (item) => item.field === field,
      )?.record.id,
    }),
  );
  if (direction !== basis.direction)
    commands.unshift({ type: "direction", value: direction });
  const valid = Object.entries(draft).every(
    ([field, value]) =>
      value === undefined ||
      validTimelineConfigValue(field as TimelineConfigField, value),
  );
  const preview = valid
    ? props.onPreviewCommand(commands, basis.sourceDocument.source)
    : undefined;
  const model = preview?.changed ? preview.model : props.model;
  const source = preview?.changed
    ? preview.source
    : props.model.sourceDocument.source;
  useEffect(() => {
    let active = true;
    setRender(undefined);
    renderMermaidSvg(source, { idPrefix: "myoxus-timeline-appearance" })
      .then((result) => {
        if (active) setRender({ source, svg: result.svg });
      })
      .catch(() => {
        if (active) setRender({ source, error: true });
      });
    return () => {
      active = false;
    };
  }, [source]);
  const value = (field: TimelineConfigField): TimelineConfigValue =>
    (model.config.effective[field] as TimelineConfigValue) ??
    (defaults[field] as TimelineConfigValue) ??
    (TIMELINE_CONFIG_FIELDS[field] === "boolean"
      ? false
      : TIMELINE_CONFIG_FIELDS[field] === "strings"
        ? []
        : "");
  const set = (
    field: TimelineConfigField,
    next: TimelineConfigValue | undefined,
  ) => setDraft((previous) => ({ ...previous, [field]: next }));
  const label = (field: TimelineConfigField) =>
    field === "useMaxWidth"
      ? messages.xyUseMaxWidth()
      : field === "leftMargin"
        ? messages.radarMarginLeft()
        : field === "padding"
          ? messages.architecturePadding()
          : field === "disableMulticolor"
            ? messages.timelineDisableMulticolor()
            : messages.timelineConfigProperty(field);
  const control = (field: TimelineConfigField) => {
    const current =
      Object.hasOwn(draft, field) && draft[field] !== undefined
        ? draft[field]!
        : value(field);
    const occurrence = model.config.occurrences.findLast(
      (item) => item.field === field,
    );
    const type = TIMELINE_CONFIG_FIELDS[field];
    return (
      <Stack key={field}>
        {type === "boolean" ? (
          <Checkbox
            label={label(field)}
            checked={current === true}
            disabled={props.readonly}
            onChange={(event) => set(field, event.currentTarget.checked)}
          />
        ) : type === "number" ? (
          <NumberInput
            label={label(field)}
            value={
              typeof current === "number" || typeof current === "string"
                ? current
                : ""
            }
            disabled={props.readonly}
            min={field === "leftMargin" || field === "padding" ? 0 : undefined}
            onChange={(next) =>
              set(
                field,
                next === ""
                  ? ""
                  : typeof next === "number"
                    ? next
                    : Number(next),
              )
            }
          />
        ) : type === "strings" ? (
          <TagsInput
            label={label(field)}
            value={Array.isArray(current) ? [...current] : []}
            disabled={props.readonly}
            onChange={(next) => set(field, next)}
          />
        ) : type === "alignment" ? (
          <Select
            label={label(field)}
            value={String(current)}
            disabled={props.readonly}
            comboboxProps={{
              withinPortal: true,
              portalProps: { target: optionsPortalTarget },
            }}
            data={[
              { value: "left", label: messages.sankeyLayoutLeft() },
              { value: "center", label: messages.sankeyLayoutCenter() },
              { value: "right", label: messages.sankeyLayoutRight() },
            ]}
            onChange={(next) => {
              if (next) set(field, next);
            }}
          />
        ) : (
          <MyoxusTextInput
            label={label(field)}
            value={String(current)}
            disabled={props.readonly}
            onChange={(next) => set(field, next)}
          />
        )}
        <MyoxusText>
          {occurrence
            ? messages.timelineConfigOrigin(
                Array.isArray(occurrence.value)
                  ? occurrence.value.join(", ")
                  : String(occurrence.value),
                occurrence.record.kind === "frontmatter" ? "---" : "%%{init}%%",
                occurrence.record.range.line,
              )
            : messages.radarDefaultValue(
                Array.isArray(defaults[field])
                  ? (defaults[field] as string[]).join(", ")
                  : String(defaults[field] ?? "—"),
              )}
        </MyoxusText>
        {!props.readonly && occurrence ? (
          <Button variant="plain" onClick={() => set(field, undefined)}>
            {messages.resetOverride()}
          </Button>
        ) : null}
        {!(TIMELINE_EFFECTIVE_CONFIG_FIELDS as readonly string[]).includes(
          field,
        ) ? (
          <MyoxusText>{messages.timelineRuntimeNoop()}</MyoxusText>
        ) : field === "disableMulticolor" &&
          !model.sections.some((section) => section.implicit) ? (
          <MyoxusText>{messages.timelineNamedMulticolor()}</MyoxusText>
        ) : null}
      </Stack>
    );
  };
  const secondary = Array.from(
    new Set([
      ...basis.config.occurrences.map((item) => item.field),
      ...Object.keys(draft),
      ...(extra ? [extra] : []),
    ]),
  ).filter(
    (field): field is TimelineConfigField =>
      Object.hasOwn(TIMELINE_CONFIG_FIELDS, field) &&
      !(TIMELINE_EFFECTIVE_CONFIG_FIELDS as readonly string[]).includes(field),
  );
  return (
    <Stack
      data-myoxus-editor-keyboard-owner="timeline-appearance"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          props.onConsumeEscape(event.nativeEvent);
          onClose();
        }
      }}
    >
      <Scrollable.Viewport autosize maxHeight="floating">
        <Stack>
          <Select
            label={messages.layoutLabel()}
            value={direction}
            disabled={props.readonly}
            data={[
              { value: "LR", label: messages.xyHorizontal() },
              { value: "TD", label: messages.xyVertical() },
            ]}
            comboboxProps={{
              withinPortal: true,
              portalProps: { target: optionsPortalTarget },
            }}
            onChange={(next) => {
              if (next === "LR" || next === "TD") setDirection(next);
            }}
          />
          {TIMELINE_EFFECTIVE_CONFIG_FIELDS.map(control)}
          <Accordion>
            <AccordionItem value="legacy">
              <AccordionControl>
                {messages.visualMoreActions()}
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  {!props.readonly ? (
                    <Select
                      label={messages.timelineConfigProperty("")}
                      value={extra ?? null}
                      comboboxProps={{
                        withinPortal: true,
                        portalProps: { target: optionsPortalTarget },
                      }}
                      data={Object.keys(TIMELINE_CONFIG_FIELDS)
                        .filter(
                          (field) =>
                            !(
                              TIMELINE_EFFECTIVE_CONFIG_FIELDS as readonly string[]
                            ).includes(field),
                        )
                        .map((field) => ({ value: field, label: field }))}
                      onChange={(next) =>
                        setExtra(next as TimelineConfigField | undefined)
                      }
                    />
                  ) : null}
                  {secondary.map(control)}
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
          {render?.source === source && render.svg ? (
            <Scrollable.Viewport
              autosize
              maxHeight="popover"
              scrollbars="xy"
              aria-label={messages.sourcePreviewLabel()}
            >
              <Box dangerouslySetInnerHTML={{ __html: render.svg }} />
            </Scrollable.Viewport>
          ) : (
            <MyoxusText>
              {render?.error ? messages.errorTitle() : messages.loading()}
            </MyoxusText>
          )}
          {notice ||
          preview?.reason === "conflict" ||
          defaultsError ||
          !valid ? (
            <Alert>
              {notice ??
                (preview?.reason === "conflict"
                  ? messages.ganttDiagnosticConflict()
                  : messages.ganttCommandRejected())}
              {preview?.reason === "conflict" ? (
                <Button
                  onClick={() => {
                    setBasis(props.model);
                    setNotice(undefined);
                  }}
                >
                  {messages.visualRetry()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {!props.readonly ? (
            <Group>
              <Button
                disabled={
                  !valid ||
                  !preview?.changed ||
                  defaultsError ||
                  render?.source !== source ||
                  render.error
                }
                onClick={() => {
                  const result = props.onCommand(
                    commands,
                    basis.sourceDocument.source,
                  );
                  if (result.changed || result.reason === "no-change")
                    onClose();
                  else
                    setNotice(
                      result.reason === "conflict"
                        ? messages.ganttDiagnosticConflict()
                        : messages.ganttCommandRejected(),
                    );
                }}
              >
                {messages.architectureApply()}
              </Button>
              <Button variant="plain" onClick={onClose}>
                {messages.cancel()}
              </Button>
            </Group>
          ) : null}
        </Stack>
      </Scrollable.Viewport>
    </Stack>
  );
}
