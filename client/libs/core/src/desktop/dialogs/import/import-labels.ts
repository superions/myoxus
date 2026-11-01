import type { DocsService } from "@myoxus/core/modules/doc";
import { waitForDocumentVersionSync } from "@myoxus/core/modules/doc-versioning/document-sync";
import type { GraphQLService } from "@myoxus/core/modules/server";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { importWorkspaceTagsMutation } from "@myoxus/graphql";
import { prepareWorkspaceImport } from "../import-workspace/workspace-import";
import type {
  SnapshotImportHooks,
  SnapshotImportLabels,
} from "@virgultum/editor/widgets/linked-doc";

/** Rust validates/maps the portable envelope; this adapter only wires lifecycle
 * and removes only newly imported live label fields after SQL succeeds. */
export async function snapshotLabelImportHooks(
  workspace: Workspace,
  docs: DocsService,
  graphql: GraphQLService,
  file: File,
): Promise<SnapshotImportHooks> {
  const { sourceHash: importId } = await prepareWorkspaceImport(file);
  const transfer = (
    labels: SnapshotImportLabels,
    validateOnly: boolean,
    targets?: Map<string, string>,
  ) =>
    graphql.gql({
      query: importWorkspaceTagsMutation,
      variables: {
        input: {
          workspaceId: workspace.id,
          importId,
          validateOnly,
          catalog: labels.catalog,
          documents: labels.documents.map((doc) => ({
            ...doc,
            externalId: targets?.get(doc.sourceId) ?? doc.sourceId,
          })),
        },
      },
    });
  return {
    validateLabels: async (labels) => {
      await transfer(labels, true);
    },
    applyLabels: async (labels, targets) => {
      for (const id of targets.values())
        await waitForDocumentVersionSync(workspace, id);
      await transfer(labels, false, targets);
      // These target records were created by this import. Old workspace roots
      // require separately approved CLI decisions, never automatic cleanup here.
      workspace.docCollection.doc.transact(() => {
        for (const target of targets.values()) {
          const meta = workspace.docCollection.meta.getDocMeta(target);
          if (!meta)
            throw new Error("Imported document identity is unavailable");
          Reflect.deleteProperty(meta, "tags");
        }
      });
    },
    compensate: async (ids) => {
      docs.moveManyToTrash(ids);
      for (const id of ids) await waitForDocumentVersionSync(workspace, id);
    },
  };
}
