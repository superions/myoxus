// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DeleteIcon,
  EditIcon,
  MoreHorizontalIcon,
  MoveToIcon,
  PlusIcon,
  TagIcon,
} from "@myoxus/icons";
import {
  Button,
  DataTree,
  IconButton,
  Menu,
  MenuItem,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  treemapNodeAggregate,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
  type TreemapSelection,
} from "@virgultum/block-mermaid";

import type { TreemapRepairAnchor } from "./chart-surface";

export function TreemapDataEditor({
  onApply,
  onAdd,
  onClass,
  onDelete,
  onEdit,
  onMove,
  onRepairRecord,
  onSelect,
  props,
  selection,
}: {
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onAdd: (parentId: string, type: "section" | "leaf") => void;
  readonly onClass: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onEdit: (id: string, field: "label" | "value") => void;
  readonly onMove: (id: string) => void;
  readonly onRepairRecord: (anchor: TreemapRepairAnchor) => void;
  readonly onSelect: (selection: TreemapSelection) => void;
  readonly props: MermaidTreemapReactHostProps;
  readonly selection: TreemapSelection;
}) {
  const nodes = (
    parentId: string | null = null,
  ): Parameters<typeof DataTree>[0]["data"] =>
    props.model.nodes
      .filter((node) => node.parentId === parentId)
      .sort((left, right) => left.sourceOrder - right.sourceOrder)
      .map((node) => ({
        actions: props.readonly ? undefined : (
          <Menu
            items={
              <>
                <MenuItem
                  leftSection={<EditIcon />}
                  onSelect={() => onEdit(node.id, "label")}
                >
                  {messages.selectedNodeLabel()}
                </MenuItem>
                {node.value === null ? (
                  <>
                    <MenuItem
                      leftSection={<PlusIcon />}
                      onSelect={() => onAdd(node.id, "section")}
                    >
                      {messages.treemapAddSection()}
                    </MenuItem>
                    <MenuItem
                      leftSection={<PlusIcon />}
                      onSelect={() => onAdd(node.id, "leaf")}
                    >
                      {messages.treemapAddLeaf()}
                    </MenuItem>
                  </>
                ) : (
                  <MenuItem
                    leftSection={<EditIcon />}
                    onSelect={() => onEdit(node.id, "value")}
                  >
                    {messages.value()}
                  </MenuItem>
                )}
                <MenuItem
                  leftSection={<MoveToIcon />}
                  onSelect={() => onMove(node.id)}
                >
                  {messages.treemapMove()}
                </MenuItem>
                <MenuItem
                  leftSection={<TagIcon />}
                  onSelect={() => onClass(node.id)}
                >
                  {messages.treemapClass()}
                </MenuItem>
                <MenuItem
                  leftSection={<DeleteIcon />}
                  onSelect={() => onDelete(node.id)}
                >
                  {messages.visualDelete()}
                </MenuItem>
              </>
            }
            title={node.label}
          >
            <IconButton
              aria-label={`${messages.visualMoreActions()}: ${node.label}`}
              icon={<MoreHorizontalIcon />}
              tooltip={messages.visualMoreActions()}
            />
          </Menu>
        ),
        cells: [
          node.value === null
            ? messages.treemapSection()
            : messages.treemapLeaf(),
          node.value === null
            ? treemapNodeAggregate(props.model, node.id)
            : node.value,
          node.className ?? "-",
        ],
        children: nodes(node.id),
        id: node.id,
        label: (
          <Stack gap="xs">
            <MyoxusText title={node.label} truncate>
              {node.label}
            </MyoxusText>
            {props.model.diagnostics
              .filter((diagnostic) => diagnostic.recordId === node.recordId)
              .map((diagnostic) => (
                <MyoxusText
                  key={`${diagnostic.code}:${diagnostic.range.start}`}
                  typographySlot="caption"
                >
                  {messages.treemapDiagnostic(
                    diagnostic.code,
                    diagnostic.range.line,
                  )}
                </MyoxusText>
              ))}
          </Stack>
        ),
        parentId: node.parentId,
        sourceOrder: node.sourceOrder,
      }));
  return (
    <Stack>
      <DataTree
        ariaLabel={messages.treemapData()}
        columns={[
          { label: messages.treemapData(), span: 4 },
          { label: messages.treemapType(), span: 2 },
          { label: messages.value(), span: 2 },
          { label: messages.treemapClass(), span: 2 },
          { label: messages.visualMoreActions(), span: 2 },
        ]}
        data={nodes()}
        onReorder={(id, siblingId, position) =>
          onApply({ type: "hierarchy.reorder", id, siblingId, position })
        }
        onSelect={(id) => onSelect({ kind: "node", id })}
        readonly={props.readonly}
        reorderLabel={messages.treemapMove()}
        selectedId={selection?.kind === "node" ? selection.id : undefined}
      />
      {props.model.diagnostics.flatMap((diagnostic) => {
        if (diagnostic.code !== "malformed-node") return [];
        const record = props.model.sourceDocument.records.find(
          (candidate) => candidate.id === diagnostic.recordId,
        );
        if (!record) return [];
        const label = messages.treemapDiagnostic(
          diagnostic.code,
          diagnostic.range.line,
        );
        return props.readonly
          ? [<MyoxusText key={record.id}>{label}</MyoxusText>]
          : [
              <Button
                key={record.id}
                variant="secondary"
                onClick={() =>
                  onRepairRecord({
                    recordId: record.id,
                    recordRaw: record.raw,
                    recordStart: record.range.start,
                  })
                }
              >
                {label}
              </Button>,
            ];
      })}
    </Stack>
  );
}
