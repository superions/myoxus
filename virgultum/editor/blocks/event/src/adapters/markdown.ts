// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockSchema } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";

const EVENT_REFERENCE_PREFIX = "myoxus-event://";

function readEventReference(node: MarkdownAST) {
  if (node.type !== "paragraph" || node.children.length !== 1) return null;
  const [child] = node.children;
  if (child.type !== "link" || !child.url.startsWith(EVENT_REFERENCE_PREFIX)) {
    return null;
  }
  const [workspaceId, eventId, extra] = child.url
    .slice(EVENT_REFERENCE_PREFIX.length)
    .split("/");
  if (!workspaceId || !eventId || extra) return null;
  return { eventId, workspaceId };
}

export const eventBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: EventBlockSchema.model.flavour,
  toMatch: (o) => readEventReference(o.node) !== null,
  fromMatch: (o) => o.node.flavour === EventBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      const reference = readEventReference(o.node);
      if (!reference) return;
      context.walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: EventBlockSchema.model.flavour,
            props: reference,
            children: [],
          },
          "children",
        )
        .closeNode();
      context.walkerContext.skipAllChildren();
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext } = context;
      const props = o.node.props as Record<string, unknown>;
      const eventId = typeof props.eventId === "string" ? props.eventId : "";
      const workspaceId =
        typeof props.workspaceId === "string" ? props.workspaceId : "";
      const reference = `${EVENT_REFERENCE_PREFIX}${workspaceId}/${eventId}`;
      walkerContext
        .openNode(
          {
            type: "blockquote",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "link",
                    url: reference,
                    title: null,
                    children: [{ type: "text", value: "Event" }],
                  },
                ],
              },
            ],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const EventBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  eventBlockMarkdownAdapterMatcher,
);
