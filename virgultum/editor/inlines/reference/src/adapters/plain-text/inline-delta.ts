import {
  AdapterTextUtils,
  configuredDocumentReferenceTitle,
  InlineDeltaToPlainTextAdapterExtension,
  type TextBuffer,
} from "@virgultum/shared/adapters";

export const referenceDeltaMarkdownAdapterMatch =
  InlineDeltaToPlainTextAdapterExtension({
    name: "reference",
    match: (delta) => !!delta.attributes?.reference,
    toAST: (delta, context) => {
      const node: TextBuffer = {
        content: delta.insert,
      };
      const reference = delta.attributes?.reference;
      if (!reference) {
        return node;
      }

      const { configs } = context;
      const title =
        configuredDocumentReferenceTitle(
          configs,
          reference.pageId,
          reference.workspaceId,
        ) ?? "";
      if (
        configuredDocumentReferenceTitle(
          configs,
          reference.pageId,
          reference.workspaceId,
        ) === undefined
      )
        return { content: reference.title ?? delta.insert };
      const url = AdapterTextUtils.generateDocUrl(
        configs.get("docLinkBaseUrl") ?? "",
        String(reference.pageId),
        reference.params ?? Object.create(null),
        reference.workspaceId,
      );
      const content = `${title ? `${title}: ` : ""}${url}`;

      return {
        content,
      };
    },
  });
