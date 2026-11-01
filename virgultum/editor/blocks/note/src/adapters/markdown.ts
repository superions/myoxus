import { NoteBlockSchema, NoteDisplayMode } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  FOOTNOTE_DEFINITION_PREFIX,
  type MarkdownAST,
  citationDefinition,
  LOCAL_FOOTNOTE_PREFIX,
  validateFootnoteDefinitions,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";
import type { Root } from "mdast";

const isRootNode = (node: MarkdownAST): node is Root => node.type === "root";

const createFootnoteDefinition = (
  identifier: string,
  content: string,
): MarkdownAST => ({
  type: "footnoteDefinition",
  label: identifier,
  identifier,
  children: [
    {
      type: "paragraph",
      children: [
        {
          type: "text",
          value: content,
        },
      ],
    },
  ],
});

/**
 * Create a markdown adapter matcher for note block.
 *
 * @param displayModeToSkip - The note with specific display mode to skip.
 * For example, the note with display mode `EdgelessOnly` should not be converted to markdown when current editor mode is `Doc`.
 * @returns The markdown adapter matcher.
 */
const createNoteBlockMarkdownAdapterMatcher = (
  displayModeToSkip: NoteDisplayMode,
): BlockMarkdownAdapterMatcher => ({
  flavour: NoteBlockSchema.model.flavour,
  toMatch: (o) => isRootNode(o.node),
  fromMatch: (o) => o.node.flavour === NoteBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!isRootNode(o.node)) {
        return;
      }
      const noteAst = o.node;
      const { configs } = context;
      const definitions = validateFootnoteDefinitions(noteAst);
      // Definitions are parent-scoped even when the parser finds them in a quote/list.
      const removeDefinitions = (node: Root | Root["children"][number]) => {
        if ("children" in node) {
          node.children = node.children.filter(
            (child) => child.type !== "footnoteDefinition",
          ) as typeof node.children;
          for (const child of node.children)
            removeDefinitions(child as Root["children"][number]);
        }
      };
      removeDefinitions(noteAst);
      const ordinary = noteAst.children;
      const local = [] as Root["children"];
      const citations = [] as Root["children"];
      for (const [identifier, definition] of definitions) {
        const reference = citationDefinition(definition);
        if (reference) {
          configs.set(
            FOOTNOTE_DEFINITION_PREFIX + identifier,
            JSON.stringify(reference),
          );
          citations.push(definition);
        } else {
          configs.set(
            LOCAL_FOOTNOTE_PREFIX + identifier,
            JSON.stringify({
              label: definition.label ?? definition.identifier,
              definitionId: nanoid(),
            }),
          );
          if (!definition.children.length)
            definition.children.push({ type: "paragraph", children: [] });
          local.push(definition);
        }
      }
      const last = ordinary.at(-1);
      const hasSourcesHeading =
        last?.type === "heading" &&
        last.depth === 6 &&
        last.children.length === 1 &&
        last.children[0]?.type === "text" &&
        last.children[0].value === "Sources";
      if (citations.length && hasSourcesHeading) {
        ordinary.pop();
        last.data = { ...last.data, collapsed: true };
        citations.unshift(last);
      } else if (citations.length)
        citations.unshift({
          type: "heading",
          depth: 6,
          data: { collapsed: true },
          children: [{ type: "text", value: "Sources" }],
        });
      noteAst.children = [...ordinary, ...local, ...citations];
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const node = o.node;
      if (node.props.displayMode === displayModeToSkip) {
        context.walkerContext.skipAllChildren();
      }
    },
    leave: (_, context) => {
      const { walkerContext, configs } = context;
      // Get all the footnote definitions config starts with FOOTNOTE_DEFINITION_PREFIX
      // And create footnoteDefinition AST node for each of them
      Array.from(configs.keys())
        .filter((key) => key.startsWith(FOOTNOTE_DEFINITION_PREFIX))
        .forEach((key) => {
          const hasFootnoteDefinition = !!walkerContext.getGlobalContext(key);
          // If the footnoteDefinition node is already in md ast, skip it
          // In markdown file, we only need to create footnoteDefinition once
          if (hasFootnoteDefinition) {
            return;
          }
          const definition = configs.get(key);
          const identifier = key.slice(FOOTNOTE_DEFINITION_PREFIX.length);
          if (definition && identifier) {
            walkerContext
              .openNode(
                createFootnoteDefinition(identifier, definition),
                "children",
              )
              .closeNode();
            // Set the footnoteDefinition node as global context to avoid duplicate creation
            walkerContext.setGlobalContext(key, true);
          }
        });
    },
  },
});

export const docNoteBlockMarkdownAdapterMatcher =
  createNoteBlockMarkdownAdapterMatcher(NoteDisplayMode.EdgelessOnly);

export const edgelessNoteBlockMarkdownAdapterMatcher =
  createNoteBlockMarkdownAdapterMatcher(NoteDisplayMode.DocOnly);

export const DocNoteBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(docNoteBlockMarkdownAdapterMatcher);

export const EdgelessNoteBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(edgelessNoteBlockMarkdownAdapterMatcher);
