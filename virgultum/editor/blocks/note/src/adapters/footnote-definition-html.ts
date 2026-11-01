// SPDX-License-Identifier: AGPL-3.0-or-later
import { footnotePlacement, type FootnotePlacement } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  HastUtils,
  LOCAL_FOOTNOTE_HTML_PREFIX,
  LOCAL_FOOTNOTE_READING_PREFIX,
} from "@virgultum/shared/adapters";

export const footnoteDefinitionHtmlAdapter = BlockHtmlAdapterExtension({
  flavour: "myoxus:footnote-definition",
  toMatch: ({ node }) =>
    HastUtils.isElement(node) &&
    node.tagName === "section" &&
    node.properties.dataMyoxusFootnoteDefinition !== undefined,
  fromMatch: ({ node }) => node.flavour === "myoxus:footnote-definition",
  toBlockSnapshot: {
    enter: ({ node }, { walkerContext, configs }) => {
      if (!HastUtils.isElement(node)) return;
      const value = configs.get(
        LOCAL_FOOTNOTE_HTML_PREFIX +
          node.properties.dataMyoxusFootnoteDefinition,
      );
      if (!value) throw new Error("Unprepared HTML footnote definition");
      const definition = JSON.parse(value) as {
        label: string;
        definitionId: string;
        placement: FootnotePlacement;
      };
      walkerContext.openNode(
        {
          type: "block",
          id: definition.definitionId,
          flavour: "myoxus:footnote-definition",
          props: { label: definition.label, placement: definition.placement },
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
    enter: ({ node }, { walkerContext, configs }) => {
      const label = String(node.props.label);
      const placement = footnotePlacement(node.props.placement);
      if (!placement) throw new Error("Invalid native footnote placement");
      const raw = configs.get(LOCAL_FOOTNOTE_READING_PREFIX + node.id);
      if (!raw) throw new Error("Missing native note reading projection");
      const { name } = JSON.parse(raw) as { name: string };
      walkerContext.openNode(
        {
          type: "element",
          tagName: "section",
          properties: {
            id: `myoxus-footnote-${node.id}`,
            dataMyoxusFootnoteDefinition: node.id,
            dataMyoxusFootnoteLabel: label,
            dataMyoxusFootnotePlacement: placement,
            ariaLabel: name,
            role: placement === "footnote" ? "doc-footnote" : "doc-endnote",
          },
          children: [
            {
              type: "element",
              tagName: "header",
              properties: { dataMyoxusFootnoteNavigation: true },
              children: [{ type: "text", value: name }],
            },
          ],
        },
        "children",
      );
    },
    leave: (_, { walkerContext }) => {
      walkerContext.closeNode();
    },
  },
});
