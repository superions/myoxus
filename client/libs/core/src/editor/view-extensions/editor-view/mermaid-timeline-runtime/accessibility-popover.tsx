// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Box,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  MyoxusTextarea,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTimelineReactHostProps,
  type TimelineCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

type Field = "accessibilityTitle" | "accessibilityDescription";
/** Remove targets the effective statement once; preview exposes any lower instance. */
export function TimelineAccessibilityPopover({
  props,
  onClose,
  optionsPortalTarget,
}: {
  readonly props: MermaidTimelineReactHostProps;
  readonly onClose: () => void;
  readonly optionsPortalTarget: string;
}) {
  const [basis, setBasis] = useState(props.model);
  const [draft, setDraft] = useState<
    Partial<Record<Field, string | undefined>>
  >({});
  const [format, setFormat] = useState<"body" | "multiline">(
    basis.metadata.find(
      (item) => item.field === "accessibilityDescription" && item.effective,
    )?.format === "multiline"
      ? "multiline"
      : "body",
  );
  const [notice, setNotice] = useState<string>();
  const commands: TimelineCommand[] = Object.entries(draft).map(
    ([field, value]) => ({
      type: "metadata",
      field: field as Field,
      value,
      format: field === "accessibilityDescription" ? format : "body",
    }),
  );
  const preview = props.onPreviewCommand(commands, basis.sourceDocument.source);
  const model = preview.changed ? preview.model : props.model;
  const metadata = (field: Field) =>
    model.metadata.find((item) => item.field === field && item.effective);
  const value = (field: Field) =>
    Object.hasOwn(draft, field) && draft[field] !== undefined
      ? draft[field]!
      : (metadata(field)?.value ?? "");
  const set = (field: Field, next: string | undefined) => {
    setDraft((previous) => ({ ...previous, [field]: next }));
    if (field === "accessibilityDescription" && next === undefined) {
      const removed = props.onPreviewCommand(
        { type: "metadata", field, value: undefined },
        basis.sourceDocument.source,
      );
      const lower = removed.model.metadata.find(
        (item) => item.field === field && item.effective,
      );
      setFormat(lower?.format === "multiline" ? "multiline" : "body");
    }
  };
  const control = (field: Field) => {
    const title =
      field === "accessibilityTitle"
        ? messages.architectureAccessibilityTitle()
        : messages.architectureAccessibilityDescription();
    const item = metadata(field);
    return (
      <Stack key={field}>
        {field === "accessibilityTitle" ? (
          <MyoxusTextInput
            label={title}
            value={value(field)}
            disabled={props.readonly}
            onChange={(next) => set(field, next)}
          />
        ) : (
          <MyoxusTextarea
            label={title}
            value={value(field)}
            disabled={props.readonly}
            onChange={(next) => set(field, next)}
          />
        )}
        {item ? (
          <MyoxusText>
            {messages.timelineConfigOrigin(
              item.value,
              item.format === "multiline"
                ? "accDescr {…}"
                : field === "accessibilityTitle"
                  ? "accTitle:"
                  : "accDescr:",
              item.range.line,
            )}
          </MyoxusText>
        ) : null}
        {!props.readonly &&
        item &&
        !(Object.hasOwn(draft, field) && draft[field] === undefined) ? (
          <Button variant="plain" onClick={() => set(field, undefined)}>
            {messages.visualDelete()}
          </Button>
        ) : null}
      </Stack>
    );
  };
  return (
    <Stack
      data-myoxus-editor-keyboard-owner="timeline-accessibility"
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
          {control("accessibilityTitle")}
          {control("accessibilityDescription")}
          <Select
            label={messages.timelineMetadataForm()}
            value={format}
            disabled={props.readonly}
            comboboxProps={{
              withinPortal: true,
              portalProps: { target: optionsPortalTarget },
            }}
            data={[
              { value: "body", label: "accDescr:" },
              { value: "multiline", label: "accDescr {…}" },
            ]}
            onChange={(next) => {
              if (next === "body" || next === "multiline") {
                setFormat(next);
                set(
                  "accessibilityDescription",
                  value("accessibilityDescription"),
                );
              }
            }}
          />
          <Box
            role="region"
            aria-label={
              metadata("accessibilityTitle")?.value ||
              model.title ||
              messages.visualEditorLabel()
            }
            aria-description={metadata("accessibilityDescription")?.value}
          >
            <MyoxusText>
              {metadata("accessibilityTitle")?.value || model.title}
            </MyoxusText>
            <MyoxusText>
              {metadata("accessibilityDescription")?.value}
            </MyoxusText>
          </Box>
          {notice ||
          (commands.length &&
            !preview.changed &&
            preview.reason !== "no-change") ? (
            <Alert>
              {notice ??
                (preview.reason === "conflict"
                  ? messages.ganttDiagnosticConflict()
                  : messages.ganttCommandRejected())}
              {preview.reason === "conflict" ? (
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
                disabled={!preview.changed}
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
