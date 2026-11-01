// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  sourceValuesEqual,
  type MermaidKanbanReactHostProps,
  type KanbanCommand,
  type MermaidKanbanNode,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { MermaidDataValue } from "../mermaid-data-value";

export function KanbanCardMetadataPopover({
  props,
  node,
  data,
  onClose,
}: {
  props: MermaidKanbanReactHostProps;
  node: MermaidKanbanNode;
  data: boolean;
  onClose: () => void;
}) {
  const readonly = props.readonly || !node.writable;
  const [basis] = useState(props.model.sourceDocument.source);
  const [label, setLabel] = useState(node.label);
  const [icon, setIcon] = useState(node.icon ?? "");
  const [metadata, setMetadata] = useState(node.metadata);
  const [id, setId] = useState(node.explicitId ?? "");
  const [delimiter, setDelimiter] = useState(node.delimiter.join(" "));
  const [className, setClassName] = useState(node.className ?? "");
  const [notice, setNotice] = useState(false);
  const card = props.model.cards.find((card) => card.id === node.id);
  const [columnId, setColumnId] = useState(card?.columnId);
  const fields = data ? [] : card ? ["assigned", "ticket", "priority"] : [];
  const commands: KanbanCommand[] = [];
  if (label !== node.label)
    commands.push({ type: "rename", id: node.id, label });
  if (icon !== (node.icon ?? ""))
    commands.push(
      node.decorationRanges.some((range) => range.field === "icon")
        ? {
            type: "decoration",
            id: node.id,
            field: "icon",
            value: icon || undefined,
          }
        : {
            type: "metadata",
            id: node.id,
            field: "icon",
            value: icon || undefined,
          },
    );
  for (const field of new Set([
    ...Object.keys(node.metadata),
    ...Object.keys(metadata),
  ])) {
    if (!sourceValuesEqual(metadata[field], node.metadata[field]))
      commands.push({
        type: "metadata",
        id: node.id,
        field,
        value: metadata[field],
      });
  }
  if (data) {
    if (id !== (node.explicitId ?? ""))
      commands.push({ type: "id", id: node.id, value: id || undefined });
    if (className !== (node.className ?? ""))
      commands.push({
        type: "decoration",
        id: node.id,
        field: "class",
        value: className || undefined,
      });
    if (delimiter !== node.delimiter.join(" ")) {
      const [open, close] = delimiter.split(" ");
      commands.push({
        type: "delimiter",
        id: node.id,
        open: open ?? "",
        close: close ?? "",
      });
    }
  }
  if (card && columnId && columnId !== card.columnId)
    commands.push({ type: "move-card", id: node.id, columnId });
  const preview = props.onPreviewCommand(commands, basis);
  const projected = [...preview.model.columns, ...preview.model.cards].find(
    (item) => item.id === node.id,
  );
  const apply = () => {
    const result = props.onCommand(commands, basis);
    if (result.changed || result.reason === "no-change") onClose();
    else setNotice(true);
  };
  return (
    <Stack data-myoxus-editor-keyboard-owner="kanban-metadata">
      <MyoxusText typographySlot="label-strong">
        {data
          ? messages.treemapData()
          : card
            ? messages.kanbanCard()
            : messages.kanbanColumn()}
      </MyoxusText>
      {notice || preview.reason === "conflict" ? (
        <Alert>{messages.ganttDiagnosticConflict()}</Alert>
      ) : null}
      {readonly ? (
        <MyoxusText>{node.label}</MyoxusText>
      ) : (
        <MyoxusTextInput
          label={messages.selectedNodeLabel()}
          value={label}
          onChange={setLabel}
        />
      )}
      {card ? (
        readonly ? (
          node.icon ? (
            <MyoxusText>{node.icon}</MyoxusText>
          ) : null
        ) : (
          <MyoxusTextInput
            label={messages.architectureIcon()}
            value={icon}
            onChange={setIcon}
          />
        )
      ) : null}
      {fields.map((field) => {
        const fieldLabel =
          field === "assigned"
            ? messages.kanbanAssigned()
            : field === "ticket"
              ? messages.kanbanTicket()
              : field === "priority"
                ? messages.kanbanPriority()
                : field;
        return data ? (
          <MermaidDataValue
            key={field}
            label={fieldLabel}
            value={metadata[field]}
            readonly={readonly}
            onChange={(value) => setMetadata({ ...metadata, [field]: value })}
          />
        ) : readonly ? (
          <Group key={field}>
            <MyoxusText>{fieldLabel}</MyoxusText>
            <MyoxusText>{String(metadata[field] ?? "")}</MyoxusText>
          </Group>
        ) : field === "priority" ? (
          <Select
            key={field}
            label={fieldLabel}
            data={[
              ...new Set([
                "Very High",
                "High",
                "Medium",
                "Low",
                "Very Low",
                String(metadata.priority ?? ""),
              ]),
            ]
              .filter(Boolean)
              .map((value) => ({ value, label: value }))}
            value={String(metadata.priority ?? "") || null}
            clearable
            onChange={(value) =>
              setMetadata({ ...metadata, priority: value || undefined })
            }
          />
        ) : (
          <MyoxusTextInput
            key={field}
            label={fieldLabel}
            value={String(metadata[field] ?? "")}
            onChange={(value) =>
              setMetadata({ ...metadata, [field]: value || undefined })
            }
          />
        );
      })}
      {data ? (
        <>
          <MyoxusText>{messages.kanbanRawNoop()}</MyoxusText>
          <MermaidDataValue
            label="ID"
            value={id}
            readonly={readonly}
            onChange={(value) => setId(String(value))}
          />
          <MermaidDataValue
            label={messages.timelineMetadataForm()}
            value={delimiter}
            readonly={readonly}
            onChange={(value) => setDelimiter(String(value))}
          />
          <MermaidDataValue
            label="class"
            value={className}
            readonly={readonly}
            onChange={(value) => setClassName(String(value))}
          />
          {
            <MermaidDataValue
              label={messages.treemapData()}
              value={metadata}
              readonly={readonly}
              onChange={(value) => {
                if (value && typeof value === "object" && !Array.isArray(value))
                  setMetadata(value as Record<string, unknown>);
              }}
            />
          }
        </>
      ) : null}
      {card && !readonly ? (
        <Select
          label={messages.kanbanColumn()}
          data={props.model.columns
            .filter((column) => column.writable)
            .map((column) => ({ label: column.label, value: column.id }))}
          value={columnId ?? null}
          onChange={(value) => setColumnId(value ?? undefined)}
        />
      ) : null}
      {projected &&
      (projected.label !== node.label || projected.icon !== node.icon) ? (
        <MyoxusText>
          {projected.label} {projected.icon}
        </MyoxusText>
      ) : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly ? (
          <Button
            disabled={!label.trim() || preview.reason === "invalid"}
            onClick={apply}
          >
            {messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
