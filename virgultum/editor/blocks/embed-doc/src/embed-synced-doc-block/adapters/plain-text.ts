import { EmbedSyncedDocBlockSchema } from "@virgultum/model";
import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/shared/services";
import {
  prepareQualifiedNativeExportSnapshot,
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";

export const embedSyncedDocBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
  {
    flavour: EmbedSyncedDocBlockSchema.model.flavour,
    toMatch: () => false,
    fromMatch: (o) =>
      o.node.flavour === EmbedSyncedDocBlockSchema.model.flavour,
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: async (o, context) => {
        const { configs, walker, walkerContext, job, textBuffer } = context;
        const type = configs.get("embedSyncedDocExportType");

        // this context is used for nested sync block
        if (
          walkerContext.getGlobalContext("embed-synced-doc-counter") ===
          undefined
        ) {
          walkerContext.setGlobalContext("embed-synced-doc-counter", 0);
        }
        let counter = walkerContext.getGlobalContext(
          "embed-synced-doc-counter",
        ) as number;
        walkerContext.setGlobalContext("embed-synced-doc-counter", ++counter);

        let buffer = "";

        if (type === "content") {
          let syncedDocId = o.node.props.pageId as string;
          const hostAccess =
            context.scopeProvider?.getOptional(DocEmbedProvider);
          let workspaceId = o.node.props.workspaceId as string | undefined;
          const resolved = await awaitDocEmbedReference(
            hostAccess,
            syncedDocId,
            workspaceId,
          );
          if (hostAccess?.openReference && !resolved)
            throw new Error("Embedded export target unavailable");
          if (resolved) {
            syncedDocId = resolved.docId;
            workspaceId = resolved.collection.id;
          }

          const qualified = workspaceId !== undefined;
          const borrowed =
            resolved ??
            (workspaceId !== undefined
              ? hostAccess?.inWorkspace?.(workspaceId)
              : undefined);
          const access = qualified ? borrowed?.access : hostAccess;
          try {
            if (!access || !(await access.canRead(syncedDocId)))
              throw new Error("Plain-text embed access denied");
            if (counter === 1)
              await access.waitForLoaded(
                syncedDocId,
                AbortSignal.timeout(30_000),
              );
            if (!(await access.canRead(syncedDocId)))
              throw new Error("Plain-text embed access lost");
            // Cached Yjs bodies and titles are not evidence of read permission.
            const syncedDoc = qualified
              ? borrowed?.collection
                  .getDoc(syncedDocId)
                  ?.getStore({ readonly: true })
              : job.docCRUD.get(syncedDocId);
            if (
              !syncedDoc?.root ||
              !syncedDoc.workspace.meta.getDocMeta(syncedDocId)
            )
              throw new Error("Plain-text embed target missing");

            if (counter === 1) {
              const captured = job.docToSnapshot(syncedDoc);
              const syncedSnapshot =
                captured && workspaceId !== undefined
                  ? await prepareQualifiedNativeExportSnapshot(
                      captured,
                      syncedDoc.workspace,
                      context.assets ?? job.assetsManager,
                      access,
                      configs,
                    )
                  : captured;
              if (!syncedSnapshot)
                throw new Error("Plain-text embed snapshot missing");
              await walker.walkONode(syncedSnapshot.blocks);
            } else {
              buffer = syncedDoc.meta?.title ?? "";
              if (buffer) {
                buffer += "\n";
              }
            }
            if (!(await access.canRead(syncedDocId)))
              throw new Error("Plain-text embed access lost");
          } finally {
            borrowed?.dispose();
          }
        }
        textBuffer.content += buffer;
      },
      leave: (_, context) => {
        const { walkerContext } = context;
        const counter = walkerContext.getGlobalContext(
          "embed-synced-doc-counter",
        ) as number;
        walkerContext.setGlobalContext("embed-synced-doc-counter", counter - 1);
      },
    },
  };

export const EmbedSyncedDocBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedSyncedDocBlockPlainTextAdapterMatcher);
