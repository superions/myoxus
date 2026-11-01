import {
  AdapterTextUtils,
  InlineDeltaToHtmlAdapterExtension,
  type InlineHtmlAST,
  configuredDocumentReferenceTitle,
  DOCUMENT_REFERENCE_TARGETS_PREFIX,
  DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX,
} from "@virgultum/shared/adapters";

export const referenceDeltaToHtmlAdapterMatcher =
  InlineDeltaToHtmlAdapterExtension({
    name: "reference",
    match: (delta) =>
      !!delta.attributes?.reference &&
      !delta.attributes.annotation &&
      !delta.attributes.code &&
      !delta.attributes.latex,
    toAST: (delta, context) => {
      let hast: InlineHtmlAST = {
        type: "text",
        value: delta.insert,
      };
      const reference = delta.attributes?.reference;
      if (!reference) {
        return hast;
      }

      const { configs } = context;
      const authorizedTitle = configuredDocumentReferenceTitle(
        configs,
        reference.pageId,
        reference.workspaceId,
      );
      const title =
        reference.title ?? authorizedTitle ?? String(reference.pageId);
      const ids = reference.params?.blockIds;
      const missingTarget =
        ids !== undefined &&
        (!Array.isArray(ids) ||
          !ids.length ||
          ids.some(
            (id) =>
              typeof id !== "string" ||
              !id ||
              (reference.workspaceId === undefined &&
                configs.has(
                  DOCUMENT_REFERENCE_TARGETS_PREFIX + reference.pageId,
                ) &&
                !configs.has(
                  DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX +
                    JSON.stringify([reference.pageId, id]),
                )),
          ));
      // A label authored in the source is not target metadata. Do not turn a
      // denied or missing target into an apparently navigable HTML anchor.
      if (typeof authorizedTitle !== "string" || missingTarget)
        return { type: "text", value: title };
      const url = AdapterTextUtils.generateDocUrl(
        configs.get("docLinkBaseUrl") ?? "",
        String(reference.pageId),
        reference.params ?? Object.create(null),
        reference.workspaceId,
      );
      if (title) {
        hast.value = title;
      }
      hast = {
        type: "element",
        tagName: "a",
        properties: {
          href: url,
        },
        children: [hast],
      };

      return hast;
    },
  });
