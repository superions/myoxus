// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockSchema } from "@virgultum/model";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";

export const eventBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher = {
  flavour: EventBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === EventBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, context) => {
      const props = o.node.props as Record<string, unknown>;
      const eventId = typeof props.eventId === "string" ? props.eventId : "";
      const workspaceId =
        typeof props.workspaceId === "string" ? props.workspaceId : "";
      context.textBuffer.content += `Event (myoxus-event://${workspaceId}/${eventId})\n`;
    },
  },
};

export const EventBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(eventBlockPlainTextAdapterMatcher);
