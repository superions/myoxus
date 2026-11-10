import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/shared/services";
import {
  EmbedSyncedDocBlockSchema,
  type ReferenceParams,
} from "@virgultum/model";
import {
  prepareQualifiedNativeExportSnapshot,
  projectDocumentFieldOutput,
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  configuredDocumentReferenceTitle,
  type DocumentEmbed,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";
import type { Link } from "mdast";

export const embedSyncedDocBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher =
  {
    flavour: EmbedSyncedDocBlockSchema.model.flavour,
    toMatch: (o) => o.node.type === "myoxusDocumentEmbed",
    fromMatch: (o) =>
      o.node.flavour === EmbedSyncedDocBlockSchema.model.flavour,
    toBlockSnapshot: {
      enter: (
        o,
        { deltaConverter, walkerContext, markdownImportDiagnostics },
      ) => {
        if (o.node.type !== "myoxusDocumentEmbed" || !o.node.reference) return;
        const before = markdownImportDiagnostics?.unresolvedReferences;
        const link = o.node.reference;
        const deltas = deltaConverter.astToDelta({
          type: "paragraph",
          children: [
            {
              ...link,
              data: { ...link.data, myoxusWikiUnsupported: false },
            },
          ],
        });
        const reference = deltas.find((delta) => delta.attributes?.reference)
          ?.attributes?.reference;
        const selected =
          reference?.params?.blockIds?.length ||
          reference?.params?.elementIds?.length;
        if (!reference || selected) {
          if (selected && markdownImportDiagnostics)
            markdownImportDiagnostics.unsupportedReferences++;
          if (
            !selected &&
            markdownImportDiagnostics &&
            markdownImportDiagnostics.unresolvedReferences === before
          )
            markdownImportDiagnostics.unresolvedReferences++;
          walkerContext
            .openNode({
              type: "block",
              id: nanoid(),
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [{ insert: o.node.value }],
                },
              },
              children: [],
            })
            .closeNode();
          return;
        }
        walkerContext
          .openNode({
            type: "block",
            id: nanoid(),
            flavour: EmbedSyncedDocBlockSchema.model.flavour,
            props: {
              pageId: reference.pageId,
              workspaceId: reference.workspaceId,
              params: reference.params,
              title: (link.data as { myoxusWikiAlias?: string })
                ?.myoxusWikiAlias,
              style: "syncedDoc",
            },
            children: [],
          })
          .closeNode();
      },
    },
    fromBlockSnapshot: {
      enter: async (o, context) => {
        const { configs, walker, walkerContext, job } = context;
        const type = configs.get("embedSyncedDocExportType");

        if (type !== "content") {
          const pageId = String(o.node.props.pageId ?? "");
          const params = o.node.props.params as ReferenceParams | undefined;
          const title =
            typeof o.node.props.title === "string"
              ? o.node.props.title
              : undefined;
          const [node] = context.deltaConverter.deltaToAST(
            [
              {
                insert: " ",
                attributes: {
                  reference: {
                    type: "LinkedPage",
                    pageId,
                    workspaceId: o.node.props.workspaceId as string | undefined,
                    params,
                    title,
                  },
                },
              },
            ],
            0,
          );
          const destination = node?.type === "link" ? (node as Link).url : "";
          const target = (destination || pageId)
            .replace(/\|/g, "%7C")
            .replace(/\[/g, "%5B")
            .replace(/\]/g, "%5D")
            .replace(/\r/g, "%0D")
            .replace(/\n/g, "%0A");
          if (
            !pageId ||
            configuredDocumentReferenceTitle(
              configs,
              pageId,
              o.node.props.workspaceId as string | undefined,
            ) === undefined
          )
            context.markdownImportDiagnostics &&
              context.markdownImportDiagnostics.unresolvedReferences++;
          if (
            params?.blockIds?.length ||
            params?.elementIds?.length ||
            (title && /[\r\n]|\]\]|\|/.test(title))
          )
            context.markdownImportDiagnostics &&
              context.markdownImportDiagnostics.unsupportedReferences++;
          walkerContext
            .openNode({
              type: "myoxusDocumentEmbed",
              value: `![[${target}${title && !/[\r\n]|\]\]|\|/.test(title) ? `|${title}` : ""}]]`,
            } as DocumentEmbed)
            .closeNode();
          return;
        }

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
            await access.waitForLoaded(
              syncedDocId,
              AbortSignal.timeout(30_000),
            );
            if (!(await access.canRead(syncedDocId)))
              throw new Error("Embedded export access lost");
            const syncedDoc =
              workspaceId !== undefined
                ? borrowed?.collection
                    .getDoc(syncedDocId)
                    ?.getStore({ readonly: true })
                : job.docCRUD.get(syncedDocId);
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
              // TODO(@L-Sun) may be use the nested content
              walkerContext
                .openNode({
                  type: "paragraph",
                  children: [
                    { type: "text", value: syncedDoc.meta?.title ?? "" },
                  ],
                })
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
        if (context.configs.get("embedSyncedDocExportType") !== "content")
          return;
        const counter = walkerContext.getGlobalContext(
          "embed-synced-doc-counter",
        ) as number;
        walkerContext.setGlobalContext("embed-synced-doc-counter", counter - 1);
      },
    },
  };

export const EmbedSyncedDocMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(embedSyncedDocBlockMarkdownAdapterMatcher);
