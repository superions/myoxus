// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";

function readProperty(value: unknown) {
  return typeof value === "string" ? value : "";
}

export const eventBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: EventBlockSchema.model.flavour,
  toMatch: (o) =>
    HastUtils.isElement(o.node) &&
    o.node.tagName === "figure" &&
    readProperty(o.node.properties.dataMyoxusBlockFlavour) ===
      EventBlockSchema.model.flavour,
  fromMatch: (o) => o.node.flavour === EventBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) return;
      context.walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: EventBlockSchema.model.flavour,
            props: {
              eventId: readProperty(o.node.properties.dataMyoxusEventId),
              workspaceId: readProperty(
                o.node.properties.dataMyoxusWorkspaceId,
              ),
            },
            children: [],
          },
          "children",
        )
        .closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext } = context;
      const props = o.node.props as Record<string, unknown>;
      const eventId = readProperty(props.eventId);
      const workspaceId = readProperty(props.workspaceId);
      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "figure",
            properties: {
              className: ["myoxus-event"],
              dataMyoxusBlockFlavour: EventBlockSchema.model.flavour,
              dataMyoxusEventId: eventId,
              dataMyoxusWorkspaceId: workspaceId,
              role: "group",
            },
            children: [
              {
                type: "element",
                tagName: "figcaption",
                properties: {},
                children: [{ type: "text", value: "Event" }],
              },
            ],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const EventBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  eventBlockHtmlAdapterMatcher,
);
