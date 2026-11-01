// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

import {
  Alert,
  Button,
  DataTreemapChart,
  d3ChartNumberFormatter,
  Group,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  treemapDescendantIds,
  treemapNodeAggregate,
  type MermaidTreemapReactHostProps,
  type TreemapNode,
  type TreemapSelection,
} from "@virgultum/block-mermaid";

export type TreemapRepairAnchor = {
  readonly recordId: string;
  readonly recordRaw: string;
  readonly recordStart: number;
};

function appearanceFor(props: MermaidTreemapReactHostProps, node: TreemapNode) {
  if (!node.className) return undefined;
  const declarations = props.model.classDefs
    .filter((definition) => definition.name === node.className)
    .flatMap((definition) => definition.declarations);
  const value = (property: string) =>
    declarations.filter((item) => item.property === property).at(-1)?.value;
  return {
    fill: value("fill"),
    stroke: value("stroke"),
    text: value("color"),
  };
}

export function treemapChartData(
  props: MermaidTreemapReactHostProps,
  parentId: string | null = null,
): Parameters<typeof DataTreemapChart>[0]["data"] {
  return props.model.nodes
    .filter((node) => node.renderable && node.parentId === parentId)
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((node) => ({
      appearance: appearanceFor(props, node),
      children: treemapChartData(props, node.id),
      className: node.className ?? undefined,
      commentCount: props.model.comments.filter(
        (comment) =>
          comment.anchor.kind === "node" && comment.anchor.id === node.id,
      ).length,
      id: node.id,
      label: node.label,
      sourceOrder: node.sourceOrder,
      type: node.value === null ? "section" : "leaf",
      value: node.value ?? 0,
    }));
}

export function TreemapChartSurface({
  commentsVisible,
  editor,
  editorNodeId,
  focusRequestKey,
  interactive,
  onAddRoot,
  onEdit,
  onOpenComment,
  onOpenClass,
  onOpenDiagramComment,
  onReparent,
  onRepairRecord,
  onSelect,
  props,
  selection,
}: {
  readonly commentsVisible: boolean;
  readonly editor?: ReactNode;
  readonly editorNodeId?: string;
  readonly focusRequestKey: number;
  readonly interactive: boolean;
  readonly onAddRoot: () => void;
  readonly onEdit: (id: string, field: "label" | "value") => void;
  readonly onOpenComment: (id: string) => void;
  readonly onOpenClass: (id: string) => void;
  readonly onOpenDiagramComment: () => void;
  readonly onReparent: (id: string, parentId: string) => void;
  readonly onRepairRecord: (anchor: TreemapRepairAnchor) => void;
  readonly onSelect: (selection: TreemapSelection) => void;
  readonly props: MermaidTreemapReactHostProps;
  readonly selection: TreemapSelection;
}) {
  const selectedNode =
    selection?.kind === "node"
      ? props.model.nodes.find((node) => node.id === selection.id)
      : undefined;
  const descendants = selectedNode
    ? treemapDescendantIds(props.model, selectedNode.id)
    : new Set<string>();
  const validParentIds = selectedNode
    ? props.model.nodes
        .filter(
          (node) =>
            node.value === null &&
            node.renderable &&
            node.id !== selectedNode.id &&
            node.id !== selectedNode.parentId &&
            !descendants.has(node.id) &&
            (selectedNode.parentId !== null || props.model.roots.length > 1),
        )
        .map((node) => node.id)
    : [];
  const total = props.model.roots.reduce(
    (sum, root) => sum + treemapNodeAggregate(props.model, root),
    0,
  );
  const hasSingleRoot = props.model.roots.length === 1;
  const malformedRecords = props.model.diagnostics.flatMap((diagnostic) => {
    if (diagnostic.code !== "malformed-node") return [];
    const record = props.model.sourceDocument.records.find(
      (candidate) => candidate.id === diagnostic.recordId,
    );
    return record ? [record] : [];
  });
  return (
    <>
      {props.model.diagnostics.length ? (
        <Alert role="status">
          {props.model.diagnostics
            .slice(0, 3)
            .map((diagnostic) =>
              messages.treemapDiagnostic(
                diagnostic.code,
                diagnostic.range.line,
              ),
            )
            .join("; ")}
        </Alert>
      ) : null}
      {interactive && malformedRecords.length ? (
        <Group role="group">
          {malformedRecords.map((record) => (
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
              {messages.treemapDiagnostic("malformed-node", record.range.line)}
            </Button>
          ))}
        </Group>
      ) : null}
      {props.model.nodes.length > 0 && total <= 0 ? (
        <Alert role="status">{messages.treemapZeroTotal()}</Alert>
      ) : null}
      {!hasSingleRoot && props.model.roots.length > 1 ? (
        <Group role="group">
          {props.model.roots.map((id) => {
            const root = props.model.nodes.find((node) => node.id === id);
            return root && interactive ? (
              <Button
                key={id}
                variant="secondary"
                onClick={() => onSelect({ kind: "node", id })}
              >
                {root.label}
              </Button>
            ) : root ? (
              <MyoxusText key={id}>{root.label}</MyoxusText>
            ) : null;
          })}
        </Group>
      ) : null}
      {hasSingleRoot && total <= 0 ? (
        interactive ? (
          <Button
            variant="secondary"
            onClick={() => onSelect({ kind: "node", id: props.model.roots[0] })}
          >
            {
              props.model.nodes.find((node) => node.id === props.model.roots[0])
                ?.label
            }
          </Button>
        ) : (
          <MyoxusText>
            {
              props.model.nodes.find((node) => node.id === props.model.roots[0])
                ?.label
            }
          </MyoxusText>
        )
      ) : (
        <DataTreemapChart
          ariaDescription={props.model.accessibilityDescription || undefined}
          ariaLabel={
            props.model.accessibilityTitle ||
            props.model.title ||
            messages.visualEditorLabel()
          }
          data={(hasSingleRoot ? treemapChartData(props) : []).map((node) => ({
            ...node,
            className: interactive ? node.className : undefined,
            commentCount:
              interactive && commentsVisible ? node.commentCount : undefined,
          }))}
          diagramCommentCount={
            commentsVisible
              ? props.model.comments.filter(
                  (comment) => comment.anchor.kind === "diagram",
                ).length
              : 0
          }
          editor={editor}
          editorNodeId={editorNodeId}
          emptyAction={
            props.readonly ? undefined : (
              <Button onClick={onAddRoot}>
                {messages.treemapRootCreate()}
              </Button>
            )
          }
          emptyLabel={props.readonly ? messages.treemapRootCreate() : ""}
          focusRequestKey={focusRequestKey}
          geometry={{
            diagramPadding: props.model.config.diagramPadding,
            nodeHeight: props.model.config.nodeHeight,
            nodeWidth: props.model.config.nodeWidth,
            padding: props.model.config.padding,
            showValues: props.model.config.showValues,
            useMaxWidth: props.model.config.useMaxWidth,
          }}
          interactive={interactive}
          labels={{
            className: messages.treemapClass(),
            comments: (count) => `${messages.visualComments()}: ${count}`,
            move: messages.treemapMove(),
          }}
          onEdit={interactive && !props.readonly ? onEdit : undefined}
          onOpenClass={interactive ? onOpenClass : undefined}
          onOpenComment={
            interactive && commentsVisible ? onOpenComment : undefined
          }
          onOpenDiagramComment={
            interactive && commentsVisible ? onOpenDiagramComment : undefined
          }
          onReparent={interactive && !props.readonly ? onReparent : undefined}
          onSelect={
            interactive ? (id) => onSelect({ kind: "node", id }) : undefined
          }
          readonly={props.readonly}
          selectedId={
            interactive && selection?.kind === "node" ? selection.id : undefined
          }
          validParentIds={validParentIds}
          valueFormatter={d3ChartNumberFormatter(
            props.model.config.valueFormat,
          )}
        />
      )}
    </>
  );
}
