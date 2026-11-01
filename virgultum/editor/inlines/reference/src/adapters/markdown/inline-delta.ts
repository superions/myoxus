import {
  AdapterTextUtils,
  DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX,
  DOCUMENT_REFERENCE_SOURCE_PATH,
  configuredDocumentReferenceTitle,
  DOCUMENT_REFERENCE_CURRENT_DOCUMENT,
  DOCUMENT_REFERENCE_TARGETS_PREFIX,
  DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX,
  markdownPreciseTargetBlockId,
  portableMarkdownTargetFragment,
  InlineDeltaToMarkdownAdapterExtension,
} from "@virgultum/shared/adapters";
import type { PhrasingContent } from "mdast";

function relativeMarkdownPath(source: string, target: string) {
  const sourceParent = source.split("/").slice(0, -1);
  const targetParts = target.split("/");
  let common = 0;
  while (
    common < sourceParent.length &&
    common < targetParts.length &&
    sourceParent[common] === targetParts[common]
  ) {
    common++;
  }
  return [
    ...sourceParent.slice(common).map(() => ".."),
    ...targetParts.slice(common).map(encodeURIComponent),
  ].join("/");
}

export const referenceDeltaToMarkdownAdapterMatcher =
  InlineDeltaToMarkdownAdapterExtension({
    name: "reference",
    match: (delta) => !!delta.attributes?.reference,
    toAST: (delta, context) => {
      let mdast: PhrasingContent = {
        type: "text",
        value: delta.insert,
      };
      const reference = delta.attributes?.reference;
      if (!reference) {
        return mdast;
      }

      const { configs } = context;
      const authorizedTitle = configuredDocumentReferenceTitle(
        configs,
        reference.pageId,
        reference.workspaceId,
      );
      const title =
        reference.title ?? authorizedTitle ?? String(reference.pageId);
      const unresolved = () => {
        if (context.markdownExportDiagnostics)
          context.markdownExportDiagnostics.unresolvedReferences += 1;
        return { type: "text" as const, value: title };
      };
      if (typeof authorizedTitle !== "string") return unresolved();
      const params = reference.params ?? {};
      const sourcePath = configs.get(DOCUMENT_REFERENCE_SOURCE_PATH);
      const targetPath =
        reference.workspaceId === undefined
          ? configs.get(
              DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX + reference.pageId,
            )
          : undefined;
      const portable =
        typeof sourcePath === "string" && typeof targetPath === "string";
      const local =
        reference.workspaceId === undefined &&
        configs.get(DOCUMENT_REFERENCE_CURRENT_DOCUMENT) === reference.pageId;
      const blockId = markdownPreciseTargetBlockId(params);
      if (
        blockId &&
        reference.workspaceId === undefined &&
        configs.has(DOCUMENT_REFERENCE_TARGETS_PREFIX + reference.pageId) &&
        !configs.has(
          DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX +
            JSON.stringify([reference.pageId, blockId]),
        )
      )
        return unresolved();
      if (blockId && (portable || local)) {
        const fragment = portableMarkdownTargetFragment(
          configs,
          reference.pageId,
          blockId,
        );
        if (fragment)
          return {
            type: "link",
            url:
              (local ? "" : relativeMarkdownPath(sourcePath!, targetPath!)) +
              "#" +
              encodeURIComponent(fragment),
            children: [{ type: "text", value: title }],
          };
        // A native target without a unique portable selector (including literal
        // code) retains its exact Myoxus URL, with a portability diagnostic.
        if (context.markdownExportDiagnostics)
          context.markdownExportDiagnostics.unsupportedReferences += 1;
      }
      const url =
        typeof sourcePath === "string" &&
        typeof targetPath === "string" &&
        Object.values(params).every((value) => value === undefined)
          ? relativeMarkdownPath(sourcePath, targetPath)
          : AdapterTextUtils.generateDocUrl(
              configs.get("docLinkBaseUrl") ?? "",
              String(reference.pageId),
              params,
              reference.workspaceId,
            );
      mdast = {
        type: "link",
        url,
        children: [
          {
            type: "text",
            value: title,
          },
        ],
      };

      return mdast;
    },
  });
