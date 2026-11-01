import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import {
  isKnownMermaidSource,
  writeMermaidSourceModelState,
} from "@virgultum/block-mermaid";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Workspace } from "@virgultum/editor/store";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";

const MERMAID_FENCE_RE = /```(?:mermaid|mmd)\b/i;
const MERMAID_FILE_RE = /\.(?:mmd|mermaid)$/i;
const MERMAID_INFO_RE = /^info\b[\s\S]*\bshowInfo\b/i;
const EXACT_MERMAID_FENCE_RE =
  /^\s*```(?:mermaid|mmd)\b[^\n]*\n([\s\S]*?)\n?```\s*$/i;

function baseName(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "") || "Mermaid diagram";
}

export function normalizeMermaidImportMarkdown(fileName: string, text: string) {
  const normalized = text.replaceAll("\r\n", "\n");
  const exactFence = normalized.match(EXACT_MERMAID_FENCE_RE);
  if (exactFence) {
    return `\`\`\`mermaid\n${exactFence[1].trimEnd()}\n\`\`\`\n`;
  }
  if (MERMAID_FENCE_RE.test(normalized)) {
    return normalized;
  }
  if (
    MERMAID_FILE_RE.test(fileName) ||
    isKnownMermaidSource(normalized) ||
    // `info/showInfo` is valid Mermaid source but intentionally not a product
    // diagram type in Virgultum's central visual editor detector.
    MERMAID_INFO_RE.test(normalized.trimStart())
  ) {
    return `\`\`\`mermaid\n${normalized.trimEnd()}\n\`\`\`\n`;
  }
  return normalized;
}

export async function importMermaidFilesToDocs({
  collection,
  files,
}: {
  collection: Workspace;
  files: File[];
}) {
  const docIds: string[] = [];
  for (const file of files) {
    const text = await file.text();
    const markdown = normalizeMermaidImportMarkdown(file.name, text);
    // Markdown owns document creation. Its fence parser normalizes EOL and
    // trailing whitespace, so standalone diagrams restore their authoritative
    // input through the same source owner before the imported doc is exposed.
    const standalone =
      !MERMAID_FENCE_RE.test(text) &&
      (MERMAID_FILE_RE.test(file.name) ||
        isKnownMermaidSource(text) ||
        MERMAID_INFO_RE.test(text.trimStart()));
    const { docId } = await MarkdownTransformer.importMarkdownToDoc({
      collection,
      schema: getMyoxusWorkspaceSchema(),
      markdown,
      fileName: baseName(file.name),
      extensions: getStoreManager().config.init().value.get("store"),
    });
    if (docId) {
      try {
        if (standalone) {
          const store = collection.getDoc(docId)?.getStore({ id: docId });
          const blocks = store?.getBlocksByFlavour("myoxus:mermaid");
          if (!store || blocks?.length !== 1)
            throw new Error(
              "Standalone Mermaid import requires one source block",
            );
          store.transact(() =>
            writeMermaidSourceModelState(
              blocks[0].model as MermaidBlockModel,
              text,
              { preserveSourceBytes: true },
            ),
          );
        }
        docIds.push(docId);
      } catch (error) {
        collection.removeDoc(docId);
        throw error;
      }
    }
  }
  return docIds;
}
