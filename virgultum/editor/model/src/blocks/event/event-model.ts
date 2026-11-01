// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";

export type EventBlockProps = {
  eventId: string;
  workspaceId: string;
};

const defaultEventBlockProps: EventBlockProps = {
  eventId: "",
  workspaceId: "",
};

export const EventBlockSchema = defineBlockSchema({
  flavour: "myoxus:event",
  props: (): EventBlockProps => defaultEventBlockProps,
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:note",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:edgeless-text",
      "myoxus:callout",
    ],
    children: [],
  },
  toModel: () => new EventBlockModel(),
});

export const EventBlockSchemaExtension = BlockSchemaExtension(EventBlockSchema);

export class EventBlockModel extends BlockModel<EventBlockProps> {}
