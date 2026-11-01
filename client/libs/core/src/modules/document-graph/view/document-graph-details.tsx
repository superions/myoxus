import {
  DocumentGraphLinkKind,
  DocumentGraphTargetState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  AllDocsIcon,
  ArrowRightSmallIcon,
  DatabaseIcon,
} from "@myoxus/icons/react";
import {
  Badge,
  Box,
  Card,
  Divider,
  Group,
  MyoxusText,
  MyoxusTitle,
  SelectableCardRow,
  Stack,
  SurfaceList,
  Tooltip,
} from "@myoxus/ui-facade";
import { useMemo } from "react";

import { documentGraphTargetKey } from "../model";
import type { DocumentGraphSelection, DocumentGraphViewModel } from "../model";

export function DocumentGraphDetails({
  graph,
  onOpenDatabase,
  onOpenDocument,
  selection,
}: {
  graph: DocumentGraphViewModel;
  selection: DocumentGraphSelection;
  onOpenDocument: (docId: string, workspaceId: string) => void;
  onOpenDatabase: (databaseId: string) => void;
}) {
  const t = useI18n();
  const details = useMemo(
    () => resolveSelectionDetails(graph, selection, t),
    [graph, selection, t],
  );
  if (!details) return null;

  return (
    <Card padding="md" fullHeight>
      <Stack gap="sm">
        <Stack gap={0}>
          <MyoxusTitle order={2} typographySlot="body">
            {details.title}
          </MyoxusTitle>
          <MyoxusText tone="secondary" typographySlot="caption">
            {t["com.myoxus.documentGraph.status.edges"]({
              count: String(details.relationships.length),
            })}
          </MyoxusText>
        </Stack>
        <Divider space="xs" />
        <SurfaceList label={t["com.myoxus.documentGraph.title"]()} gap="xs">
          {details.relationships.map((relationship) => (
            <SelectableCardRow
              key={relationship.key}
              appearance="row"
              density="compact"
              disabled={!relationship.id}
              onClick={() => {
                if (!relationship.id) return;
                if (relationship.kind === "document") {
                  onOpenDocument(
                    relationship.id,
                    relationship.workspaceId ?? graph.workspaceId,
                  );
                } else {
                  onOpenDatabase(relationship.id);
                }
              }}
            >
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  {relationship.kind === "document" ? (
                    <AllDocsIcon />
                  ) : (
                    <DatabaseIcon />
                  )}
                  <Stack gap={0}>
                    <MyoxusText typographySlot="body-small">
                      {relationship.title}
                    </MyoxusText>
                    <MyoxusText tone="secondary" typographySlot="caption">
                      {relationship.meta}
                    </MyoxusText>
                  </Stack>
                </Group>
                <Tooltip
                  content={
                    relationship.direction === "incoming"
                      ? t["com.myoxus.documentGraph.direction.incoming"]()
                      : t["com.myoxus.documentGraph.direction.outgoing"]()
                  }
                >
                  <Box component="span">
                    <ArrowRightSmallIcon />
                  </Box>
                </Tooltip>
              </Group>
            </SelectableCardRow>
          ))}
        </SurfaceList>
        <Divider space="xs" />
        <Group gap="xs">
          <Badge tone={details.available ? "success" : "warning"}>
            {details.available
              ? t["com.myoxus.documentGraph.state.available"]()
              : t["com.myoxus.documentGraph.state.unresolved"]()}
          </Badge>
          <Badge tone="neutral">{details.typeLabel}</Badge>
        </Group>
      </Stack>
    </Card>
  );
}

type Relationship = {
  key: string;
  kind: "document" | "database";
  id: string | null;
  title: string;
  workspaceId?: string;
  meta: string;
  direction: "incoming" | "outgoing";
};

function resolveSelectionDetails(
  graph: DocumentGraphViewModel,
  selection: DocumentGraphSelection,
  t: ReturnType<typeof useI18n>,
) {
  if (selection.kind === "database") {
    const database = graph.databases.find((item) => item.id === selection.id);
    if (!database) return null;
    return {
      title: database.title,
      typeLabel: t["com.myoxus.database.template.profile.database"](),
      available: true,
      relationships: database.references.map(
        (reference, index): Relationship => ({
          key: `${reference.rowId}:${reference.fieldId ?? "content"}:${index}`,
          kind: "document",
          id: reference.targetDocId,
          workspaceId: reference.targetWorkspaceId ?? undefined,
          title:
            graph.nodes.find(
              (node) =>
                node.key ===
                documentGraphTargetKey(
                  reference.targetWorkspaceId,
                  reference.targetDocId,
                  reference.rawTargetDocId,
                ),
            )?.label ?? reference.rawTargetDocId,
          meta: linkKindLabel(t, DocumentGraphLinkKind.DatabaseCellReference),
          direction: "outgoing",
        }),
      ),
    };
  }

  const node = graph.nodes.find((item) => item.key === selection.id);
  if (!node) return null;
  const documentRelationships = graph.edges.flatMap(
    (edge, index): Relationship[] => {
      const isSource = edge.sourceKey === node.key;
      const isTarget = edge.targetKey === node.key;
      if (!isSource && !isTarget) return [];
      const relatedRawId = isSource ? edge.rawTargetDocId : edge.sourceDocId;
      const relatedKey = isSource ? edge.targetKey : edge.sourceKey;
      const related = graph.nodes.find(
        (candidate) => candidate.key === relatedKey,
      );
      return [
        {
          key: `${edge.sourceDocId}:${edge.rawTargetDocId}:${edge.linkKind}:${index}`,
          kind: "document",
          id: related?.docId ?? null,
          workspaceId: related?.workspaceId,
          title: related?.label ?? relatedRawId,
          meta: linkKindLabel(t, edge.linkKind),
          direction: isSource ? "outgoing" : "incoming",
        },
      ];
    },
  );
  const databaseRelationships = graph.databaseReferences.flatMap(
    (reference, index): Relationship[] =>
      documentGraphTargetKey(
        reference.targetWorkspaceId,
        reference.targetDocId,
        reference.rawTargetDocId,
      ) === node.key
        ? [
            {
              key: `${reference.databaseId}:${reference.rowId}:${index}`,
              kind: "database",
              id: reference.databaseId,
              title: reference.databaseTitle,
              meta: linkKindLabel(
                t,
                DocumentGraphLinkKind.DatabaseCellReference,
              ),
              direction: "incoming",
            },
          ]
        : [],
  );
  return {
    title: node.label,
    typeLabel: node.documentType || node.status || t["Page"](),
    available:
      !node.redacted &&
      !node.deleted &&
      graph.edges
        .filter(
          (edge) => edge.sourceKey === node.key || edge.targetKey === node.key,
        )
        .every(
          (edge) => edge.targetState === DocumentGraphTargetState.Available,
        ),
    relationships: [...documentRelationships, ...databaseRelationships],
  };
}

function linkKindLabel(
  t: ReturnType<typeof useI18n>,
  value: DocumentGraphLinkKind,
) {
  switch (value) {
    case DocumentGraphLinkKind.InlineReference:
      return t["com.myoxus.documentGraph.linkKind.inline-reference"]();
    case DocumentGraphLinkKind.EmbedLinkedDoc:
      return t["com.myoxus.documentGraph.linkKind.embed-linked-doc"]();
    case DocumentGraphLinkKind.EmbedSyncedDoc:
      return t["com.myoxus.documentGraph.linkKind.embed-synced-doc"]();
    case DocumentGraphLinkKind.SurfaceRef:
      return t["com.myoxus.documentGraph.linkKind.surface-ref"]();
    case DocumentGraphLinkKind.DatabaseCellReference:
      return t["com.myoxus.documentGraph.linkKind.database-cell-reference"]();
  }
}
