// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type SankeyCommand,
  type MermaidSankeyReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function SankeyLinkPopover({
  props,
  id,
  initial,
  onApply,
  onCancel,
  onDelete,
  onPreviewModel,
  endpointsEditable = true,
}: {
  readonly props: MermaidSankeyReactHostProps;
  readonly id?: string;
  readonly initial?: {
    readonly source: string;
    readonly target: string;
    readonly value?: number;
  };
  readonly onApply: (commands: readonly SankeyCommand[]) => boolean;
  readonly onCancel: () => void;
  readonly onDelete?: () => void;
  readonly endpointsEditable?: boolean;
  readonly onPreviewModel?: (
    model: MermaidSankeyReactHostProps["model"],
  ) => void;
}) {
  const record = props.model.sourceDocument.records.find(
    (record) => record.id === id,
  );
  const [source, setSource] = useState(
    record?.fields[0]?.value ?? initial?.source ?? "",
  );
  const [target, setTarget] = useState(
    record?.fields[1]?.value ?? initial?.target ?? "",
  );
  const [value, setValue] = useState<string | number>(
    record?.fields[2]?.value ?? initial?.value ?? "",
  );
  const commandsFor = (
    nextSource: string,
    nextTarget: string,
    nextValue: string | number,
  ): readonly SankeyCommand[] =>
    id
      ? [
          ...(nextSource !== record?.fields[0]?.value
            ? [
                {
                  type: "link.endpoint" as const,
                  id,
                  field: "source" as const,
                  value: nextSource,
                },
              ]
            : []),
          ...(nextTarget !== record?.fields[1]?.value
            ? [
                {
                  type: "link.endpoint" as const,
                  id,
                  field: "target" as const,
                  value: nextTarget,
                },
              ]
            : []),
          ...(String(nextValue) !== record?.fields[2]?.value
            ? [
                {
                  type: "link.value" as const,
                  id,
                  value: nextValue === "" ? NaN : Number(nextValue),
                },
              ]
            : []),
        ]
      : [
          {
            type: "link.add",
            source: nextSource,
            target: nextTarget,
            value: nextValue === "" ? NaN : Number(nextValue),
          },
        ];
  const commands = commandsFor(source, target, value);
  const preview = props.onPreviewCommand(commands);
  const updatePreview = (
    nextSource: string,
    nextTarget: string,
    nextValue: string | number,
  ) => {
    const result = props.onPreviewCommand(
      commandsFor(nextSource, nextTarget, nextValue),
    );
    if (result.changed) onPreviewModel?.(result.model);
  };
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onConsumeEscape(event.nativeEvent);
        event.stopPropagation();
      }}
    >
      {endpointsEditable ? (
        <>
          <MyoxusTextInput
            label={messages.chartSource()}
            value={source}
            onChange={(next) => {
              setSource(next);
              updatePreview(next, target, value);
            }}
            autoFocus
            disabled={props.readonly}
          />
          <MyoxusTextInput
            label={messages.chartTarget()}
            value={target}
            onChange={(next) => {
              setTarget(next);
              updatePreview(source, next, value);
            }}
            disabled={props.readonly}
          />
        </>
      ) : (
        <Group>
          <MyoxusText>{source}</MyoxusText>
          <MyoxusText aria-hidden>→</MyoxusText>
          <MyoxusText>{target}</MyoxusText>
        </Group>
      )}
      <NumberInput
        label={messages.selectedSankeyValue()}
        value={value}
        onChange={(next) => {
          setValue(next);
          updatePreview(source, target, next);
        }}
        disabled={props.readonly}
        autoFocus={!endpointsEditable}
      />
      <Group justify="flex-end">
        {onDelete ? (
          <Button color="myoxusError" variant="plain" onClick={onDelete}>
            {messages.visualDelete()}
          </Button>
        ) : null}
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={props.readonly || !preview.changed}
          onClick={() => onApply(commands)}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
