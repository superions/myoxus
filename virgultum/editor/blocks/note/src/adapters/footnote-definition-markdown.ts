// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BlockMarkdownAdapterExtension,
  citationDefinition,
  LOCAL_FOOTNOTE_PREFIX,
  normalizeFootnoteLabel,
} from "@virgultum/shared/adapters";

export const footnoteDefinitionMarkdownAdapter = BlockMarkdownAdapterExtension({
  flavour: "myoxus:footnote-definition",
  toMatch: ({ node }) =>
    node.type === "footnoteDefinition" && !citationDefinition(node),
  fromMatch: ({ node }) => node.flavour === "myoxus:footnote-definition",
  toBlockSnapshot: {
    enter: ({ node }, { walkerContext, configs }) => {
      if (node.type !== "footnoteDefinition") return;
      const saved = configs.get(
        LOCAL_FOOTNOTE_PREFIX + normalizeFootnoteLabel(node.identifier),
      );
      if (!saved)
        throw new Error(`Unprepared footnote definition: ${node.identifier}`);
      const footnote = JSON.parse(saved) as {
        label: string;
        definitionId: string;
      };
      walkerContext.openNode(
        {
          type: "block",
          id: footnote.definitionId,
          flavour: "myoxus:footnote-definition",
          props: { label: footnote.label, placement: "footnote" },
          children: [],
        },
        "children",
      );
    },
    leave: (_, { walkerContext }) => {
      walkerContext.closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: ({ node }, { walkerContext }) => {
      const label = String(node.props.label);
      walkerContext.openNode(
        {
          type: "footnoteDefinition",
          label,
          identifier: normalizeFootnoteLabel(label),
          children: [],
        },
        "children",
      );
    },
    leave: (_, { walkerContext }) => {
      walkerContext.closeNode();
    },
  },
});
