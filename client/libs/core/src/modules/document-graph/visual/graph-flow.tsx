import "@xyflow/react/dist/base.css";

import { DatabaseIcon, LinkIcon } from "@myoxus/icons/react";
import {
  Badge,
  Box,
  Card,
  Group,
  MyoxusText,
  SelectableCardRow,
  Stack,
  useThemeValue,
} from "@myoxus/ui-facade";
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import { documentGraphTargetKey } from "../model";
import type {
  DocumentGraphDatabaseModel,
  DocumentGraphDatabaseReference,
  DocumentGraphEdgeModel,
  DocumentGraphNodeModel,
  DocumentGraphSelection,
  DocumentGraphViewModel,
} from "../model";
import { layoutDocumentGraph } from "./graph-layout";

type DocumentNodeData = {
  kind: "document";
  node: DocumentGraphNodeModel;
  selection: DocumentGraphSelection;
  selected: boolean;
  relationCount: string;
  labels: Pick<GraphFlowProps["labels"], "deleted" | "document" | "redacted">;
};

type DatabaseNodeData = {
  kind: "database";
  database: DocumentGraphDatabaseModel;
  selection: DocumentGraphSelection;
  selected: boolean;
  databaseLabel: string;
  relationCount: string;
};

type GraphNodeData = DocumentNodeData | DatabaseNodeData;

type GraphEdgeData =
  | { kind: "document"; edge: DocumentGraphEdgeModel }
  | { kind: "database"; reference: DocumentGraphDatabaseReference };

type GraphFlowProps = {
  graph: DocumentGraphViewModel;
  selection: DocumentGraphSelection | null;
  onSelect: (selection: DocumentGraphSelection | null) => void;
  onOpenDocument: (docId: string, workspaceId: string) => void;
  onOpenDatabase: (databaseId: string) => void;
  labels: {
    redacted: string;
    deleted: string;
    document: string;
    database: string;
    edgeCount: (count: number) => string;
  };
};

export function DocumentGraphFlow(props: GraphFlowProps) {
  return (
    <ReactFlowProvider>
      <DocumentGraphFlowInner {...props} />
    </ReactFlowProvider>
  );
}

function DocumentGraphFlowInner({
  graph,
  labels,
  onOpenDatabase,
  onOpenDocument,
  onSelect,
  selection,
}: GraphFlowProps) {
  const reactFlow = useReactFlow();
  const { nodes, edges } = useMemo(
    () => toReactFlowModel(graph, selection, labels),
    [graph, labels, selection],
  );

  useEffect(() => {
    void reactFlow.fitView({ maxZoom: 1, padding: 0.05 });
  }, [nodes, reactFlow]);

  return (
    <Card
      component="section"
      display="flex"
      flexDirection="column"
      fullHeight
      overflow="hidden"
      padding="md"
      data-myoxus-ui-role="document-graph-visual"
    >
      <Box
        display="flex"
        flex="1 1 auto"
        mih="31rem"
        miw={0}
        // React Flow measures its direct parent. This is renderer geometry,
        // not route chrome or a parallel visual system.
        style={{ overflow: "hidden" }}
        data-myoxus-ui-role="document-graph-visual-canvas"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={{
            myoxusDocument: GraphDocumentNode,
            myoxusDatabase: GraphDatabaseNode,
          }}
          edgeTypes={{ myoxusRelationship: GraphRelationshipEdge }}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.05 }}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => onSelect(node.data.selection)}
          onNodeDoubleClick={(_, node) => {
            if (node.data.kind === "document") {
              if (node.data.node.docId && !node.data.node.redacted) {
                onOpenDocument(
                  node.data.node.docId,
                  node.data.node.workspaceId,
                );
              }
            } else {
              onOpenDatabase(node.data.database.id);
            }
          }}
          proOptions={{ hideAttribution: true }}
        />
      </Box>
    </Card>
  );
}

function GraphDocumentNode({ data }: { data: DocumentNodeData }) {
  const node = data.node;
  return (
    <SelectableCardRow
      appearance="card"
      density="compact"
      selected={data.selected}
      data-myoxus-ui-role="document-graph-document-node"
    >
      <GraphNodeHandles />
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Badge tone={data.selected ? "info" : "neutral"}>
            {node.documentType || data.labels.document}
          </Badge>
          <Group gap="xs">
            {node.redacted ? (
              <Badge tone="warning">{data.labels.redacted}</Badge>
            ) : null}
            {node.deleted ? (
              <Badge tone="error">{data.labels.deleted}</Badge>
            ) : null}
          </Group>
        </Group>
        <MyoxusText typographySlot="body-small">{node.label}</MyoxusText>
        <Group gap="xs" wrap="nowrap">
          <LinkIcon />
          <MyoxusText tone="secondary" typographySlot="caption">
            {data.relationCount}
          </MyoxusText>
        </Group>
      </Stack>
    </SelectableCardRow>
  );
}

function GraphDatabaseNode({ data }: { data: DatabaseNodeData }) {
  return (
    <SelectableCardRow
      appearance="card"
      density="compact"
      selected={data.selected}
      data-myoxus-ui-role="document-graph-database-node"
    >
      <GraphNodeHandles />
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Badge tone={data.selected ? "info" : "neutral"}>
            {data.databaseLabel}
          </Badge>
          <DatabaseIcon />
        </Group>
        <MyoxusText typographySlot="body-small">
          {data.database.title}
        </MyoxusText>
        <Group gap="xs" wrap="nowrap">
          <LinkIcon />
          <MyoxusText tone="secondary" typographySlot="caption">
            {data.relationCount}
          </MyoxusText>
        </Group>
      </Stack>
    </SelectableCardRow>
  );
}

function GraphNodeHandles() {
  return (
    <>
      <GraphNodeHandle
        id="target-left"
        type="target"
        position={Position.Left}
      />
      <GraphNodeHandle
        id="target-right"
        type="target"
        position={Position.Right}
      />
      <GraphNodeHandle
        id="source-left"
        type="source"
        position={Position.Left}
      />
      <GraphNodeHandle
        id="source-right"
        type="source"
        position={Position.Right}
      />
      <GraphNodeHandle id="target-top" type="target" position={Position.Top} />
      <GraphNodeHandle
        id="target-bottom"
        type="target"
        position={Position.Bottom}
      />
      <GraphNodeHandle id="source-top" type="source" position={Position.Top} />
      <GraphNodeHandle
        id="source-bottom"
        type="source"
        position={Position.Bottom}
      />
    </>
  );
}

function GraphNodeHandle({
  id,
  position,
  type,
}: {
  id: string;
  position: Position;
  type: "source" | "target";
}) {
  return (
    <Handle id={id} type={type} position={position} style={{ opacity: 0 }} />
  );
}

function GraphRelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<GraphEdgeData>>) {
  const stroke = useThemeValue("borderColor");
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      style={{
        stroke,
        strokeWidth: "calc(var(--mantine-scale) * 1px)",
        strokeDasharray: data?.kind === "database" ? "8 8" : undefined,
      }}
    />
  );
}

function toReactFlowModel(
  graph: DocumentGraphViewModel,
  selection: DocumentGraphSelection | null,
  labels: GraphFlowProps["labels"],
): { nodes: Node<GraphNodeData>[]; edges: Edge<GraphEdgeData>[] } {
  const documentNodeIds = new Set(
    graph.nodes.map((node) => documentNodeId(node.key)),
  );
  const documentEdges: Edge<GraphEdgeData>[] = graph.edges
    .filter(
      (edge) =>
        documentNodeIds.has(documentNodeId(edge.sourceKey)) &&
        documentNodeIds.has(documentNodeId(edge.targetKey)),
    )
    .map((edge, index) => ({
      id: `document:${edge.sourceDocId}:${edge.rawTargetDocId}:${edge.linkKind}:${index}`,
      source: documentNodeId(edge.sourceKey),
      target: documentNodeId(edge.targetKey),
      type: "myoxusRelationship",
      data: { kind: "document", edge },
      animated:
        edge.staleState === "Queued" || edge.staleState === "Extracting",
    }));
  const databaseEdges: Edge<GraphEdgeData>[] = graph.databaseReferences
    .filter((reference) =>
      documentNodeIds.has(
        documentNodeId(
          documentGraphTargetKey(
            reference.targetWorkspaceId,
            reference.targetDocId,
            reference.rawTargetDocId,
          ),
        ),
      ),
    )
    .map((reference, index) => ({
      id: `database:${reference.databaseId}:${reference.rowId}:${reference.fieldId ?? "content"}:${reference.rawTargetDocId}:${index}`,
      source: databaseNodeId(reference.databaseId),
      target: documentNodeId(
        documentGraphTargetKey(
          reference.targetWorkspaceId,
          reference.targetDocId,
          reference.rawTargetDocId,
        ),
      ),
      type: "myoxusRelationship",
      data: { kind: "database", reference },
    }));
  const allEdges = [...documentEdges, ...databaseEdges];
  const allNodeIds = [
    ...graph.nodes.map((node) => documentNodeId(node.key)),
    ...graph.databases.map((database) => databaseNodeId(database.id)),
  ];
  const centerId = selection
    ? selection.kind === "document"
      ? documentNodeId(selection.id)
      : databaseNodeId(selection.id)
    : highestDegreeNodeId(allNodeIds, allEdges);
  const visibleNodeIds = focusedNodeIds(allNodeIds, allEdges, centerId, 4);
  const edges = allEdges.filter(
    (edge) =>
      visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  );
  const layout = layoutDocumentGraph(
    [
      ...graph.nodes
        .filter((node) => visibleNodeIds.has(documentNodeId(node.key)))
        .map((node) => ({
          id: documentNodeId(node.key),
          kind: "document" as const,
        })),
      ...graph.databases
        .filter((database) => visibleNodeIds.has(databaseNodeId(database.id)))
        .map((database) => ({
          id: databaseNodeId(database.id),
          kind: "database" as const,
        })),
    ],
    edges.map(({ source, target }) => ({ source, target })),
    centerId,
  );
  const positionedEdges = edges.map((edge) => {
    const source = layout.get(edge.source);
    const target = layout.get(edge.target);
    const horizontal =
      Math.abs((source?.x ?? 0) - (target?.x ?? 0)) >=
      Math.abs((source?.y ?? 0) - (target?.y ?? 0));
    const pointsRight = (source?.x ?? 0) <= (target?.x ?? 0);
    const pointsDown = (source?.y ?? 0) <= (target?.y ?? 0);
    return {
      ...edge,
      sourceHandle: horizontal
        ? pointsRight
          ? "source-right"
          : "source-left"
        : pointsDown
          ? "source-bottom"
          : "source-top",
      targetHandle: horizontal
        ? pointsRight
          ? "target-left"
          : "target-right"
        : pointsDown
          ? "target-top"
          : "target-bottom",
    };
  });
  const nodes: Node<GraphNodeData>[] = graph.nodes
    .filter((node) => visibleNodeIds.has(documentNodeId(node.key)))
    .map((node) => {
      const id = documentNodeId(node.key);
      const relationCount =
        graph.edges.filter(
          (edge) => edge.sourceKey === node.key || edge.targetKey === node.key,
        ).length +
        graph.databaseReferences.filter(
          (reference) =>
            documentGraphTargetKey(
              reference.targetWorkspaceId,
              reference.targetDocId,
              reference.rawTargetDocId,
            ) === node.key,
        ).length;
      return {
        id,
        type: "myoxusDocument",
        data: {
          kind: "document",
          node,
          selection: { kind: "document", id: node.key },
          selected: selection?.kind === "document" && selection.id === node.key,
          relationCount: labels.edgeCount(relationCount),
          labels,
        },
        position: layout.get(id) ?? { x: 0, y: 0 },
        style: { width: 180 },
      };
    });

  nodes.push(
    ...graph.databases
      .filter((database) => visibleNodeIds.has(databaseNodeId(database.id)))
      .map((database, index) => ({
        id: databaseNodeId(database.id),
        type: "myoxusDatabase",
        data: {
          kind: "database" as const,
          database,
          selection: { kind: "database" as const, id: database.id },
          selected:
            selection?.kind === "database" && selection.id === database.id,
          databaseLabel: labels.database,
          relationCount: labels.edgeCount(database.references.length),
        },
        position: layout.get(databaseNodeId(database.id)) ?? {
          x: 0,
          y: index * 140,
        },
        style: { width: 180 },
      })),
  );
  return { nodes, edges: positionedEdges };
}

function highestDegreeNodeId(nodeIds: string[], edges: Edge<GraphEdgeData>[]) {
  const degree = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return [...nodeIds].sort(
    (left, right) =>
      (degree.get(right) ?? 0) - (degree.get(left) ?? 0) ||
      left.localeCompare(right),
  )[0];
}

/** Keeps the canvas legible while details retain every direct relationship. */
function focusedNodeIds(
  nodeIds: string[],
  edges: Edge<GraphEdgeData>[],
  centerId: string | undefined,
  contextLimit: number,
) {
  if (!centerId) return new Set(nodeIds.slice(0, contextLimit + 1));
  const neighbors = new Map(nodeIds.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    neighbors.get(edge.source)?.push(edge.target);
    neighbors.get(edge.target)?.push(edge.source);
  }
  const visible = new Set([centerId]);
  const queue = [centerId];
  for (const queuedNodeId of queue) {
    for (const neighbor of neighbors.get(queuedNodeId) ?? []) {
      if (visible.has(neighbor)) continue;
      visible.add(neighbor);
      queue.push(neighbor);
      if (visible.size === contextLimit + 1) return visible;
    }
  }
  return visible;
}

const documentNodeId = (id: string) => `document:${id}`;
const databaseNodeId = (id: string) => `database:${id}`;
