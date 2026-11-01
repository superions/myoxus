import {
  EmbedLinkedDocBlockSchema,
  FootNoteReferenceParamsSchema,
} from "@virgultum/model";
import {
  AdapterTextUtils,
  configuredDocumentReferenceTitle,
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  FOOTNOTE_DEFINITION_PREFIX,
  getFootnoteDefinitionText,
  isFootnoteDefinitionNode,
  type MarkdownAST,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";

const isLinkedDocFootnoteDefinitionNode = (node: MarkdownAST) => {
  if (!isFootnoteDefinitionNode(node)) return false;
  const footnoteDefinition = getFootnoteDefinitionText(node);
  try {
    const footnoteDefinitionJson = FootNoteReferenceParamsSchema.parse(
      JSON.parse(footnoteDefinition),
    );
    return (
      footnoteDefinitionJson.type === "doc" && !!footnoteDefinitionJson.docId
    );
  } catch {
    return false;
  }
};

export const embedLinkedDocBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher =
  {
    flavour: EmbedLinkedDocBlockSchema.model.flavour,
    toMatch: (o) => isLinkedDocFootnoteDefinitionNode(o.node),
    fromMatch: (o) =>
      o.node.flavour === EmbedLinkedDocBlockSchema.model.flavour,
    toBlockSnapshot: {
      enter: (o, context) => {
        if (!isFootnoteDefinitionNode(o.node)) {
          return;
        }

        const { walkerContext, configs } = context;
        const footnoteIdentifier = o.node.identifier;
        const footnoteDefinitionKey = `${FOOTNOTE_DEFINITION_PREFIX}${footnoteIdentifier}`;
        const footnoteDefinition = configs.get(footnoteDefinitionKey);
        if (!footnoteDefinition) {
          return;
        }
        try {
          const footnoteDefinitionJson = FootNoteReferenceParamsSchema.parse(
            JSON.parse(footnoteDefinition),
          );
          const { docId, workspaceId } = footnoteDefinitionJson;
          if (!docId) {
            return;
          }
          walkerContext
            .openNode(
              {
                type: "block",
                id: nanoid(),
                flavour: EmbedLinkedDocBlockSchema.model.flavour,
                props: {
                  pageId: docId,
                  workspaceId,
                  footnoteIdentifier,
                  style: "citation",
                },
                children: [],
              },
              "children",
            )
            .closeNode();
          walkerContext.skipAllChildren();
        } catch (err) {
          console.warn("Failed to parse linked doc footnote definition:", err);
          return;
        }
      },
    },
    fromBlockSnapshot: {
      enter: (o, context) => {
        const { configs, walkerContext } = context;
        // Parse as link
        if (!o.node.props.pageId) {
          return;
        }
        const title =
          configuredDocumentReferenceTitle(
            configs,
            String(o.node.props.pageId),
            o.node.props.workspaceId as string | undefined,
          ) ?? "untitled";
        const url = AdapterTextUtils.generateDocUrl(
          configs.get("docLinkBaseUrl") ?? "",
          String(o.node.props.pageId),
          o.node.props.params ?? Object.create(null),
          o.node.props.workspaceId as string | undefined,
        );
        walkerContext
          .openNode(
            {
              type: "paragraph",
              children: [],
            },
            "children",
          )
          .openNode(
            {
              type: "link",
              url,
              title: o.node.props.caption as string | null,
              children: [
                {
                  type: "text",
                  value: title,
                },
              ],
            },
            "children",
          )
          .closeNode()
          .closeNode();
      },
    },
  };

export const EmbedLinkedDocMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(embedLinkedDocBlockMarkdownAdapterMatcher);
