import fs from "node:fs";
import path from "node:path";

import {
  DatabaseDocumentReferenceKind,
  DocumentGraphLinkKind,
  DocumentGraphStaleState,
  DocumentGraphTargetState,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import { normalizeDocumentGraphResponse } from "./model";

const repoRoot = process.cwd();

function readRepoFile(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Document Graph client contract", () => {
  test("normalizes graph responses once for lens and visual consumers", () => {
    const graph = normalizeDocumentGraphResponse({
      nodes: [
        {
          docId: "source-doc",
          workspaceId: "",
          rawDocId: "source-doc",
          title: "Source",
          documentType: null,
          status: "draft",
          classification: null,
          deleted: false,
          redacted: false,
        },
        {
          docId: "target-doc",
          workspaceId: "",
          rawDocId: "target-doc",
          title: "Target",
          documentType: null,
          status: null,
          classification: null,
          deleted: false,
          redacted: false,
        },
      ],
      edges: [
        {
          sourceDocId: "source-doc",
          targetDocId: "target-doc",
          targetWorkspaceId: "",
          rawTargetDocId: "previous-route",
          targetState: DocumentGraphTargetState.Available,
          linkKind: DocumentGraphLinkKind.InlineReference,
          occurrenceCount: 2,
          firstOccurrencePreview: "Preview",
          staleState: DocumentGraphStaleState.Current,
          occurrences: [],
        },
      ],
      databaseReferences: [],
      indexStatus: {
        staleState: DocumentGraphStaleState.Current,
        indexedAt: null,
        queuedAt: null,
        startedAt: null,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        occurrenceCount: 2,
        currentCount: 1,
        staleCount: 0,
        queuedCount: 0,
        extractingCount: 0,
        failedCount: 0,
        deletedCount: 0,
        missingStateCount: 0,
      },
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges[0].targetKey).toBe(graph.nodes[1].key);
    expect(graph.edges[0]).toMatchObject({
      sourceLabel: "Source",
      targetLabel: "Target",
      occurrenceCount: 2,
    });
  });

  test("keeps unavailable graph targets visible for lens and visual renderers", () => {
    const graph = normalizeDocumentGraphResponse({
      nodes: [
        {
          docId: "source-doc",
          workspaceId: "",
          rawDocId: "source-doc",
          title: "Source",
          documentType: null,
          status: null,
          classification: null,
          deleted: false,
          redacted: false,
        },
      ],
      edges: [
        {
          sourceDocId: "source-doc",
          targetDocId: null,
          targetWorkspaceId: "",
          rawTargetDocId: "not-a-visible-doc",
          targetState: DocumentGraphTargetState.Unresolved,
          linkKind: DocumentGraphLinkKind.InlineReference,
          occurrenceCount: 1,
          firstOccurrencePreview: null,
          staleState: DocumentGraphStaleState.Current,
          occurrences: [],
        },
      ],
      databaseReferences: [],
      indexStatus: {
        staleState: DocumentGraphStaleState.Current,
        indexedAt: null,
        queuedAt: null,
        startedAt: null,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        occurrenceCount: 1,
        currentCount: 1,
        staleCount: 0,
        queuedCount: 0,
        extractingCount: 0,
        failedCount: 0,
        deletedCount: 0,
        missingStateCount: 0,
      },
    });

    expect(graph.nodes.map((node) => node.rawDocId)).toContain(
      "not-a-visible-doc",
    );
    expect(graph.edges[0]).toMatchObject({
      sourceLabel: "Source",
      targetLabel: "not-a-visible-doc",
    });
  });

  test("keeps unavailable document states and typed Database references separate", () => {
    const graph = normalizeDocumentGraphResponse({
      nodes: [
        {
          docId: "source-doc",
          workspaceId: "",
          rawDocId: "source-doc",
          title: "Source document",
          documentType: "document",
          status: "ready",
          classification: null,
          deleted: false,
          redacted: false,
        },
        {
          docId: null,
          workspaceId: "",
          rawDocId: "template-doc",
          title: null,
          documentType: null,
          status: null,
          classification: null,
          deleted: false,
          redacted: true,
        },
        {
          docId: null,
          workspaceId: "",
          rawDocId: "deleted-doc",
          title: null,
          documentType: null,
          status: null,
          classification: null,
          deleted: true,
          redacted: false,
        },
      ],
      edges: [
        {
          sourceDocId: "source-doc",
          targetDocId: null,
          targetWorkspaceId: "",
          rawTargetDocId: "template-doc",
          targetState: DocumentGraphTargetState.Redacted,
          linkKind: DocumentGraphLinkKind.InlineReference,
          occurrenceCount: 1,
          firstOccurrencePreview: null,
          staleState: DocumentGraphStaleState.Current,
          occurrences: [],
        },
        {
          sourceDocId: "source-doc",
          targetDocId: null,
          targetWorkspaceId: "",
          rawTargetDocId: "deleted-doc",
          targetState: DocumentGraphTargetState.Deleted,
          linkKind: DocumentGraphLinkKind.InlineReference,
          occurrenceCount: 1,
          firstOccurrencePreview: null,
          staleState: DocumentGraphStaleState.Stale,
          occurrences: [],
        },
        {
          sourceDocId: "source-doc",
          targetDocId: null,
          targetWorkspaceId: "",
          rawTargetDocId: "missing-doc",
          targetState: DocumentGraphTargetState.Missing,
          linkKind: DocumentGraphLinkKind.InlineReference,
          occurrenceCount: 1,
          firstOccurrencePreview: null,
          staleState: DocumentGraphStaleState.Queued,
          occurrences: [],
        },
      ],
      databaseReferences: [
        {
          databaseId: "database-id",
          databaseTitle: "Launch plan",
          rowId: "row-id",
          rowTitle: "Alpha Launch",
          fieldId: null,
          fieldName: null,
          referenceKind: DatabaseDocumentReferenceKind.RowContentDocument,
          targetWorkspaceId: "",
          rawTargetDocId: "source-doc",
          targetDocId: "source-doc",
          refreshedAt: "2026-07-13T00:00:00Z",
        },
      ],
      indexStatus: {
        staleState: DocumentGraphStaleState.Queued,
        indexedAt: null,
        queuedAt: null,
        startedAt: null,
        failedAt: null,
        errorCode: null,
        errorMessage: null,
        attemptCount: 0,
        occurrenceCount: 3,
        currentCount: 1,
        staleCount: 1,
        queuedCount: 1,
        extractingCount: 0,
        failedCount: 0,
        deletedCount: 0,
        missingStateCount: 1,
      },
    });

    expect(graph.edges.map((edge) => edge.targetState)).toEqual([
      DocumentGraphTargetState.Redacted,
      DocumentGraphTargetState.Deleted,
      DocumentGraphTargetState.Missing,
    ]);
    expect(
      graph.nodes.map((node) => [node.rawDocId, node.label]),
    ).toContainEqual(["missing-doc", "missing-doc"]);
    expect(graph.edges[0]).toMatchObject({
      sourceLabel: "Source document",
      targetLabel: "template-doc",
    });
    expect(graph.databaseReferences[0]).toMatchObject({
      databaseTitle: "Launch plan",
      rowTitle: "Alpha Launch",
      referenceKind: DatabaseDocumentReferenceKind.RowContentDocument,
    });
    expect(graph.indexStatus).toMatchObject({
      missingStateCount: 1,
      queuedCount: 1,
      staleCount: 1,
    });
  });

  test("keeps Browser Web document links on the server Document Graph contract", () => {
    const module = readRepoFile(
      "client/libs/core/src/modules/doc-link/index.ts",
    );
    const backlinks = readRepoFile(
      "client/libs/core/src/modules/doc-link/entities/doc-backlinks.ts",
    );
    const outgoing = readRepoFile(
      "client/libs/core/src/modules/doc-link/entities/doc-links.ts",
    );

    expect(backlinks).toContain("documentLinksQuery");
    expect(outgoing).toContain("documentLinksQuery");
    expect(backlinks).toContain("shouldUseServerDocumentGraph");
    expect(outgoing).toContain("shouldUseServerDocumentGraph");
    expect(backlinks).toContain("!BUILD_CONFIG.isElectron");
    expect(outgoing).toContain("!BUILD_CONFIG.isElectron");
    expect(outgoing).toContain("? new LiveData<Link[]>([])");
    expect(module).toContain("WorkspaceServerService");
    expect(module).toContain("DefaultServerService");
    expect(module).not.toContain("GraphQLService");
    expect(backlinks).toContain(
      "this.serverService?.scope.get(GraphQLService)",
    );
    expect(outgoing).toContain("this.serverService?.scope.get(GraphQLService)");
  });

  test("keeps the All Content graph view on server metadata filters", () => {
    const page = readRepoFile(
      "client/libs/core/src/modules/document-graph/view/document-graph-workspace-view.tsx",
    );
    const filters = readRepoFile(
      "client/libs/core/src/modules/document-graph/view/filter-options.ts",
    );

    expect(page).toContain("metadataFilter");
    expect(filters).toContain("documentStatusValuesQuery");
    expect(filters).toContain("documentTypesQuery");
    expect(filters).toContain("documentMetadataValueDefinitionsQuery");
    expect(page).not.toContain("@myoxus/storage");
  });

  test("keeps React Flow isolated to the visual renderer", () => {
    const page = readRepoFile(
      "client/libs/core/src/modules/document-graph/view/document-graph-workspace-view.tsx",
    );
    const visual = readRepoFile(
      "client/libs/core/src/modules/document-graph/visual/graph-flow.tsx",
    );

    expect(page).not.toContain("@xyflow/react");
    expect(visual).toContain("@xyflow/react");
    expect(visual).not.toContain("MiniMap");
    expect(visual).not.toContain("Controls");
  });
});
