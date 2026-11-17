import {
  DocEmbedProvider,
  awaitDocEmbedReference,
} from "@virgultum/core/services/data";
import {
  EmbedSyncedDocBlockSchema,
  type ReferenceParams,
} from "@virgultum/core/models";
import {
  prepareQualifiedNativeExportSnapshot,
  projectDocumentReferenceSelection,
  projectDocumentFieldOutput,
  AdapterTextUtils,
  hasDocumentReferenceSelection,
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  configuredDocumentReferenceTitle,
  markdownPreciseTargetBlockId,
  type DocumentEmbed,
} from "@virgultum/core/adapters";
import { type BlockSnapshot, nanoid } from "@virgultum/core/store";
import type { Link } from "mdast";

export const embedSyncedDocBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher =
  {
    flavour: EmbedSyncedDocBlockSchema.model.flavour,
    toMatch: (o) => o.node.type === "myoxusDocumentEmbed",
    fromMatch: (o) =>
      o.node.flavour === EmbedSyncedDocBlockSchema.model.flavour,
    toBlockSnapshot: {
      enter: (o, { deltaConverter, walkerContext }) => {
        if (o.node.type !== "myoxusDocumentEmbed" || !o.node.reference) return;
        const link = o.node.reference;
        const source = o.node.value;
        const deltas = deltaConverter.astToDelta({
          type: "paragraph",
          children: [
            {
              ...link,
              data: { ...link.data, myoxusWikiUnsupported: false },
            },
          ],
        });
        const block: BlockSnapshot = {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:paragraph",
          props: {},
          children: [],
        };
        deltaConverter.bindImportedDeltas(() => {
          const reference = deltas.find((delta) => delta.attributes?.reference)
            ?.attributes?.reference;
          const selected =
            !!(
              reference?.params?.blockIds?.length ||
              reference?.params?.elementIds?.length
            ) && !markdownPreciseTargetBlockId(reference.params);
          if (!reference || selected) {
            if (selected && deltaConverter.importDiagnostics)
              deltaConverter.importDiagnostics.unsupportedReferences++;
            block.flavour = "myoxus:paragraph";
            block.props = {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [{ insert: source }],
              },
            };
          } else {
            block.flavour = EmbedSyncedDocBlockSchema.model.flavour;
            block.props = {
              pageId: reference.pageId,
              workspaceId: reference.workspaceId,
              params: reference.params,
              title: (link.data as { myoxusWikiAlias?: string })
                ?.myoxusWikiAlias,
              style: "syncedDoc",
            };
          }
        });
        walkerContext.openNode(block).closeNode();
      },
    },
    fromBlockSnapshot: {
      enter: async (o, context) => {
        const { configs, walker, walkerContext, job } = context;
        const type = configs.get("embedSyncedDocExportType");

        if (type !== "content") {
          const pageId = String(o.node.props.pageId ?? "");
          const authoredParams = o.node.props.params as
            ReferenceParams | undefined;
          const params =
            authoredParams &&
            markdownPreciseTargetBlockId(authoredParams) &&
            authoredParams.blockSelection === undefined
              ? { ...authoredParams, blockSelection: "subtree" as const }
              : authoredParams;
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
          const selected = hasDocumentReferenceSelection(params);
          // A missing target must not turn an exact embed into a whole-note
          // relation. Reuse the native URL writer without reading target data.
          const destination =
            node?.type === "link"
              ? (node as Link).url
              : selected
                ? AdapterTextUtils.generateDocUrl(
                    configs.get("docLinkBaseUrl") ?? "",
                    pageId,
                    params ?? {},
                    o.node.props.workspaceId as string | undefined,
                  )
                : "";
          if (selected && !destination)
            throw new Error(
              "Selected embed export requires its native URL context",
            );
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
            ((params?.blockIds?.length || params?.elementIds?.length) &&
              !markdownPreciseTargetBlockId(params)) ||
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
              const complete = job.docToSnapshot(syncedDoc);
              const captured =
                complete &&
                projectDocumentReferenceSelection(
                  complete,
                  o.node.props.params,
                );
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
