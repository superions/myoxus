import type {
  Blockquote,
  FootnoteDefinition,
  Root,
  RootContentMap,
} from "mdast";

export type Markdown = string;

/** Payload-free fidelity findings collected during one Markdown conversion. */
export type MarkdownImportDiagnostics = {
  unresolvedReferences: number;
  unsupportedReferences: number;
  unsupportedAnnotations?: number;
  normalizedAnnotations?: number;
  unsupportedCallouts?: number;
  unsupportedMath?: number;
  unsupportedTables?: number;
  unreferencedFootnotes?: number;
  normalizedEndnotes?: number;
};

export const emptyMarkdownImportDiagnostics =
  (): MarkdownImportDiagnostics => ({
    unresolvedReferences: 0,
    unsupportedReferences: 0,
  });

export const hasMarkdownImportDiagnostics = (
  diagnostics: MarkdownImportDiagnostics,
) =>
  diagnostics.unresolvedReferences > 0 ||
  diagnostics.unsupportedReferences > 0 ||
  (diagnostics.unsupportedAnnotations ?? 0) > 0 ||
  (diagnostics.normalizedAnnotations ?? 0) > 0 ||
  (diagnostics.unsupportedCallouts ?? 0) > 0 ||
  (diagnostics.unsupportedMath ?? 0) > 0 ||
  (diagnostics.unsupportedTables ?? 0) > 0 ||
  (diagnostics.unreferencedFootnotes ?? 0) > 0 ||
  (diagnostics.normalizedEndnotes ?? 0) > 0;

type MdastUnionType<
  K extends keyof RootContentMap,
  V extends RootContentMap[K],
> = V;

export type MarkdownAST =
  | MdastUnionType<keyof RootContentMap, RootContentMap[keyof RootContentMap]>
  | Root;

export const isMarkdownAST = (node: unknown): node is MarkdownAST =>
  !Array.isArray(node) &&
  "type" in (node as object) &&
  (node as MarkdownAST).type !== undefined;

export const isFootnoteDefinitionNode = (
  node: MarkdownAST,
): node is FootnoteDefinition => node.type === "footnoteDefinition";

export const getFootnoteDefinitionText = (node: FootnoteDefinition) => {
  if (node.children.length !== 1) return "";
  const child = node.children[0];
  if (
    child.type !== "paragraph" ||
    child.children.some((part) => part.type !== "text")
  )
    return "";
  return child.children
    .map((part) => (part.type === "text" ? part.value : ""))
    .join("");
};

type CalloutBlockquote = Blockquote & {
  data: Blockquote["data"] & {
    isCallout: true;
    calloutEmoji?: string;
  };
};

export const isCalloutNode = (node: MarkdownAST): node is CalloutBlockquote => {
  return (
    node.type === "blockquote" && !!(node as CalloutBlockquote).data?.isCallout
  );
};

export const getCalloutEmoji = (node: CalloutBlockquote) => {
  return node.data?.calloutEmoji ?? "";
};

export const FOOTNOTE_DEFINITION_PREFIX = "footnoteDefinition:";
export const IN_PARAGRAPH_NODE_CONTEXT_KEY = "mdast:paragraph";
