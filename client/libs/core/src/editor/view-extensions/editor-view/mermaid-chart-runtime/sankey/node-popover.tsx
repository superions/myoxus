// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  ColorInput,
  Group,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidSankeyReactHostProps,
  type SankeyCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function SankeyNodePopover({
  props,
  id,
  onApply,
  onCancel,
  onDelete,
  onPreviewModel,
}: {
  readonly props: MermaidSankeyReactHostProps;
  readonly id: string;
  readonly onApply: (commands: readonly SankeyCommand[]) => boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onPreviewModel?: (
    model: MermaidSankeyReactHostProps["model"],
  ) => void;
}) {
  const node = props.model.nodes.find((candidate) => candidate.id === id);
  const [label, setLabel] = useState(node?.label ?? "");
  const [color, setColor] = useState(
    node ? (props.model.config.nodeColors[node.label] ?? "") : "",
  );
  const [mergeConfirmed, setMergeConfirmed] = useState(false);
  const target = props.model.nodes.find(
    (candidate) => candidate.id !== id && candidate.label === label.trim(),
  );
  const targetColor = target
    ? props.model.config.nodeColors[target.label]
    : undefined;
  const colorConflict = Boolean(targetColor && color && targetColor !== color);
  const commandsFor = (
    nextLabel: string,
    nextColor: string,
    confirmed: boolean,
  ) => {
    const commands: SankeyCommand[] = [];
    if (node && nextLabel.trim() !== node.label)
      commands.push({
        type: "node.rename",
        id,
        label: nextLabel,
        confirmed,
      });
    if (
      node &&
      nextColor !== (props.model.config.nodeColors[node.label] ?? "")
    ) {
      const nodeColors = { ...props.model.config.nodeColors };
      delete nodeColors[node.label];
      if (nextColor) nodeColors[nextLabel.trim() || node.label] = nextColor;
      commands.push({
        type: "config.set",
        field: "nodeColors",
        value: nodeColors,
      });
    }
    return commands;
  };
  const previewFor = (
    nextLabel: string,
    nextColor: string,
    confirmed: boolean,
  ) => {
    const result = props.onPreviewCommand(
      commandsFor(nextLabel, nextColor, confirmed),
    );
    onPreviewModel?.(result.changed ? result.model : props.model);
    return result;
  };
  const commands = commandsFor(label, color, mergeConfirmed);
  const preview = props.onPreviewCommand(commands);
  const requiresMerge = preview.diagnosis === "confirmation-required";
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onConsumeEscape(event.nativeEvent);
        event.stopPropagation();
      }}
    >
      <MyoxusTextInput
        label={messages.selectedNodeLabel()}
        value={label}
        onChange={(next) => {
          setLabel(next);
          setMergeConfirmed(false);
          previewFor(next, color, false);
        }}
        disabled={props.readonly}
        autoFocus
      />
      <ColorInput
        allowEmpty
        label={messages.sankeyNodeColor()}
        value={color}
        onChange={(next) => {
          setColor(next);
          previewFor(label, next, mergeConfirmed);
        }}
        disabled={props.readonly}
      />
      {requiresMerge || mergeConfirmed ? (
        <Alert role="status">{messages.sankeyMergeImpact()}</Alert>
      ) : null}
      <Group justify="flex-end">
        <Button color="myoxusError" variant="plain" onClick={onDelete}>
          {messages.visualDelete()}
        </Button>
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={
            props.readonly ||
            colorConflict ||
            (!preview.changed && !requiresMerge)
          }
          onClick={() => {
            if (requiresMerge && !mergeConfirmed) {
              setMergeConfirmed(true);
              previewFor(label, color, true);
              return;
            }
            onApply(commands);
          }}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
