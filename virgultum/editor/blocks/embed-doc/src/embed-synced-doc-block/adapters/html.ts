import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/shared/services";
import { EmbedSyncedDocBlockSchema } from "@virgultum/model";
import {
  prepareQualifiedNativeExportSnapshot,
  projectDocumentFieldOutput,
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
  MarkdownAdapter,
} from "@virgultum/shared/adapters";

export const embedSyncedDocBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: EmbedSyncedDocBlockSchema.model.flavour,
  toMatch: (o) =>
    HastUtils.isElement(o.node) &&
    o.node.tagName === "div" &&
    o.node.properties.dataMyoxusDocumentEmbed === "reference",
  fromMatch: (o) => o.node.flavour === EmbedSyncedDocBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: async (o, context) => {
      // Preserve HTML clipboard priority and surrounding HTML structure. This
      // owned fragment carries the same relation syntax as Markdown, not a body.
      const adapter = new MarkdownAdapter(
        context.job,
        context.deltaConverter.provider,
      );
      for (const [key, value] of context.configs)
        adapter.configs.set(key, value);
      const snapshot = await adapter.toBlockSnapshot({
        file: HastUtils.getTextContent(o.node, ""),
      });
      for (const block of snapshot.children)
        context.walkerContext.openNode(block).closeNode();
      context.walkerContext.skipAllChildren();
    },
  },
  fromBlockSnapshot: {
    enter: async (o, context) => {
      const { configs, walker, walkerContext, job } = context;
      const type = configs.get("embedSyncedDocExportType");
      if (type !== "content") {
        const adapter = new MarkdownAdapter(
          job,
          context.deltaConverter.provider,
        );
        for (const [key, value] of configs) adapter.configs.set(key, value);
        const reference = await adapter.fromBlockSnapshot({ snapshot: o.node });
        walkerContext
          .openNode({
            type: "element",
            tagName: "div",
            properties: { dataMyoxusDocumentEmbed: "reference" },
            children: [{ type: "text", value: reference.file.trim() }],
          })
          .closeNode();
        return;
      }

      // this context is used for nested sync block
      if (
        walkerContext.getGlobalContext("embed-synced-doc-counter") === undefined
      ) {
        walkerContext.setGlobalContext("embed-synced-doc-counter", 0);
      }
      let counter = walkerContext.getGlobalContext(
        "embed-synced-doc-counter",
      ) as number;
      walkerContext.setGlobalContext("embed-synced-doc-counter", ++counter);

      if (type === "content") {
        let syncedDocId = o.node.props.pageId as string;
        const hostAccess = context.scopeProvider?.getOptional(DocEmbedProvider);
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

        const borrowed =
          resolved ??
          (workspaceId !== undefined
            ? hostAccess?.inWorkspace?.(workspaceId)
            : undefined);
        const access =
          workspaceId !== undefined ? borrowed?.access : hostAccess;
        try {
          if (!access || !(await access.canRead(syncedDocId)))
            throw new Error("Embedded export access denied");
          await access.waitForLoaded(syncedDocId, AbortSignal.timeout(30_000));
          if (!(await access.canRead(syncedDocId)))
            throw new Error("Embedded export access lost");
          const syncedDoc =
            workspaceId !== undefined
              ? borrowed?.collection
                  .getDoc(syncedDocId)
                  ?.getStore({ readonly: true })
              : job.docCRUD.get(syncedDocId);
          walkerContext.setGlobalContext("hast:html-root-doc", false);
          if (!syncedDoc) return;

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
            if (syncedSnapshot) {
              const output = await projectDocumentFieldOutput(
                syncedSnapshot,
                context.scopeProvider,
                syncedDocId,
                syncedDoc.workspace.id,
              );
              await walker.walkONode(output.blocks);
            }
          } else {
            walkerContext
              .openNode(
                {
                  type: "element",
                  tagName: "div",
                  properties: {
                    className: ["myoxus-paragraph-block-container"],
                  },
                  children: [],
                },
                "children",
              )
              .openNode(
                {
                  type: "element",
                  tagName: "p",
                  properties: {},
                  children: [
                    { type: "text", value: syncedDoc.meta?.title ?? "" },
                  ],
                },
                "children",
              )
              .closeNode()
              .closeNode();
          }
          if (!(await access.canRead(syncedDocId)))
            throw new Error("Embedded export access lost");
        } finally {
          borrowed?.dispose();
        }
      }
    },
    leave: (_, context) => {
      const { walkerContext } = context;
      if (context.configs.get("embedSyncedDocExportType") !== "content") return;
      const counter = walkerContext.getGlobalContext(
        "embed-synced-doc-counter",
      ) as number;
      const currentCounter = counter - 1;
      walkerContext.setGlobalContext(
        "embed-synced-doc-counter",
        currentCounter,
      );
      // When leave the last embed synced doc block, we need to set the html root doc context to true
      walkerContext.setGlobalContext(
        "hast:html-root-doc",
        currentCounter === 0,
      );
    },
  },
};

export const EmbedSyncedDocBlockHtmlAdapterExtension =
  BlockHtmlAdapterExtension(embedSyncedDocBlockHtmlAdapterMatcher);
