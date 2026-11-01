import type {
  DocumentGraphEdgeFieldsFragment,
  DocumentGraphNodeFieldsFragment,
  DocumentGraphQuery,
} from "@myoxus/graphql";

export type DocumentGraphNodeModel = DocumentGraphNodeFieldsFragment & {
  label: string;
  key: string;
};

export type DocumentGraphEdgeModel = DocumentGraphEdgeFieldsFragment & {
  sourceLabel: string;
  sourceKey: string;
  targetKey: string;
  targetLabel: string;
};

export type DocumentGraphDatabaseReference = NonNullable<
  NonNullable<DocumentGraphQuery["workspace"]>["documentGraph"]
>["databaseReferences"][number];

export type DocumentGraphDatabaseModel = {
  id: string;
  title: string;
  references: DocumentGraphDatabaseReference[];
};

export type DocumentGraphSelection =
  { kind: "document"; id: string } | { kind: "database"; id: string };

export type DocumentGraphViewModel = {
  workspaceId: string;
  nodes: DocumentGraphNodeModel[];
  edges: DocumentGraphEdgeModel[];
  databases: DocumentGraphDatabaseModel[];
  databaseReferences: NonNullable<
    NonNullable<DocumentGraphQuery["workspace"]>["documentGraph"]
  >["databaseReferences"];
  indexStatus: NonNullable<
    NonNullable<DocumentGraphQuery["workspace"]>["documentGraph"]
  >["indexStatus"];
};

/** Connect guarded current routes while retaining unavailable stored addresses. */
export function documentGraphTargetKey(
  workspaceId: string | null,
  docId: string | null,
  rawDocId: string,
) {
  return JSON.stringify([workspaceId, docId ?? rawDocId]);
}

export function normalizeDocumentGraphResponse(
  graph: NonNullable<
    NonNullable<DocumentGraphQuery["workspace"]>["documentGraph"]
  >,
  workspaceId = "",
): DocumentGraphViewModel {
  const nodes: DocumentGraphNodeModel[] = graph.nodes.map((node) => ({
    ...node,
    key: JSON.stringify([node.workspaceId, node.rawDocId]),
    label: node.title?.trim() || node.rawDocId,
  }));
  const byRawId = new Map(nodes.map((node) => [node.key, node]));
  const byDocId = new Map(
    nodes
      .filter((node): node is DocumentGraphNodeModel & { docId: string } =>
        Boolean(node.docId),
      )
      .map((node) => [JSON.stringify([node.workspaceId, node.docId]), node]),
  );
  const ensureTargetNode = (
    rawDocId: string,
    docId: string | null,
    scope: string | null,
  ) => {
    const key = documentGraphTargetKey(scope, docId, rawDocId);
    if (byRawId.has(key)) {
      return;
    }
    const placeholder: DocumentGraphNodeModel = {
      docId,
      rawDocId,
      workspaceId: scope ?? "",
      key,
      title: null,
      documentType: null,
      status: null,
      classification: null,
      deleted: false,
      redacted: false,
      label: rawDocId,
    };
    // Missing, unresolved and ACL-redacted targets are still graph facts.
    // The server withholds document details where needed; this placeholder
    // only lets every renderer show the same relationship set.
    nodes.push(placeholder);
    byRawId.set(key, placeholder);
    if (placeholder.docId) {
      byDocId.set(
        JSON.stringify([placeholder.workspaceId, placeholder.docId]),
        placeholder as DocumentGraphNodeModel & { docId: string },
      );
    }
  };
  for (const edge of graph.edges) {
    ensureTargetNode(
      edge.rawTargetDocId,
      edge.targetDocId,
      edge.targetWorkspaceId,
    );
  }
  for (const reference of graph.databaseReferences) {
    ensureTargetNode(
      reference.rawTargetDocId,
      reference.targetDocId,
      reference.targetWorkspaceId,
    );
  }
  const databasesById = new Map<string, DocumentGraphDatabaseModel>();
  for (const reference of graph.databaseReferences) {
    const existing = databasesById.get(reference.databaseId);
    if (existing) {
      existing.references.push(reference);
      continue;
    }
    databasesById.set(reference.databaseId, {
      id: reference.databaseId,
      title: reference.databaseTitle.trim() || reference.databaseId,
      references: [reference],
    });
  }
  const labelFor = (
    docId: string | null,
    rawDocId: string,
    scope: string | null,
  ) =>
    (docId ? byDocId.get(JSON.stringify([scope, docId]))?.label : undefined) ??
    byRawId.get(JSON.stringify([scope, rawDocId]))?.label ??
    rawDocId;

  return {
    workspaceId,
    nodes,
    edges: graph.edges.map((edge) => ({
      ...edge,
      sourceKey: JSON.stringify([workspaceId, edge.sourceDocId]),
      targetKey: documentGraphTargetKey(
        edge.targetWorkspaceId,
        edge.targetDocId,
        edge.rawTargetDocId,
      ),
      sourceLabel: labelFor(edge.sourceDocId, edge.sourceDocId, workspaceId),
      targetLabel: labelFor(
        edge.targetDocId,
        edge.rawTargetDocId,
        edge.targetWorkspaceId,
      ),
    })),
    databases: [...databasesById.values()],
    databaseReferences: graph.databaseReferences,
    indexStatus: graph.indexStatus,
  };
}

export function documentGraphStatusCount(
  status: DocumentGraphViewModel["indexStatus"],
) {
  return (
    status.staleCount +
    status.queuedCount +
    status.extractingCount +
    status.failedCount +
    status.missingStateCount
  );
}
