import { FootNoteReferenceParamsSchema } from "@virgultum/model";
import {
  FOOTNOTE_DEFINITION_PREFIX,
  LOCAL_FOOTNOTE_PREFIX,
  normalizeFootnoteLabel,
  MarkdownASTToDeltaExtension,
} from "@virgultum/shared/adapters";

export const markdownFootnoteReferenceToDeltaMatcher =
  MarkdownASTToDeltaExtension({
    name: "footnote-reference",
    match: (ast) => ast.type === "footnoteReference",
    toDelta: (ast, context) => {
      if (ast.type !== "footnoteReference") {
        return [];
      }
      const local = context.configs.get(
        LOCAL_FOOTNOTE_PREFIX + normalizeFootnoteLabel(ast.identifier),
      );
      if (local)
        return [{ insert: " ", attributes: { footnote: JSON.parse(local) } }];
      try {
        const { configs } = context;
        const footnoteDefinitionKey = `${FOOTNOTE_DEFINITION_PREFIX}${ast.identifier}`;
        const footnoteDefinition = configs.get(footnoteDefinitionKey);
        if (!footnoteDefinition) {
          throw new Error(`Missing footnote definition: ${ast.identifier}`);
        }
        const footnoteDefinitionJson = JSON.parse(footnoteDefinition);
        // If the footnote definition contains url, decode it
        if (footnoteDefinitionJson.url) {
          footnoteDefinitionJson.url = decodeURIComponent(
            footnoteDefinitionJson.url,
          );
        }
        if (footnoteDefinitionJson.favicon) {
          footnoteDefinitionJson.favicon = decodeURIComponent(
            footnoteDefinitionJson.favicon,
          );
        }
        const footnoteReference = FootNoteReferenceParamsSchema.parse(
          footnoteDefinitionJson,
        );

        // If the footnote reference is an attachment, and the file type is not set,
        // Try to infer the file type from the file name.
        const { type: referenceType, fileName, fileType } = footnoteReference;
        if (referenceType === "attachment" && fileName && !fileType) {
          const ext = fileName.split(".").pop()?.toLowerCase();
          if (ext) {
            footnoteReference.fileType = ext;
          }
        }

        const footnote = {
          label: ast.identifier,
          reference: footnoteReference,
        };
        return [{ insert: " ", attributes: { footnote } }];
      } catch {
        throw new Error(`Invalid citation definition: ${ast.identifier}`);
      }
    },
  });
