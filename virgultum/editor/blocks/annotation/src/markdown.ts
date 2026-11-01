// SPDX-License-Identifier: AGPL-3.0-or-later
import { BlockMarkdownAdapterExtension } from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";

export const annotationMarkdownAdapter = BlockMarkdownAdapterExtension({
  flavour: "myoxus:annotation",
  toMatch: ({ node }) => node.type === "myoxusAnnotationBlock",
  fromMatch: ({ node }) => node.flavour === "myoxus:annotation",
  toBlockSnapshot: {
    enter: ({ node }, { walkerContext }) => {
      if (node.type !== "myoxusAnnotationBlock") return;
      walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:annotation",
            children: [],
            props: {
              text: {
                "$virgultum:internal:text$": true,
                delta: node.value ? [{ insert: node.value }] : [],
              },
            },
          },
          "children",
        )
        .closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: ({ node }, { walkerContext }) => {
      const text = node.props.text as { delta: { insert: string }[] };
      walkerContext
        .openNode(
          {
            type: "myoxusAnnotationBlock",
            value: text.delta.map((delta) => delta.insert).join(""),
          },
          "children",
        )
        .closeNode();
    },
  },
});
