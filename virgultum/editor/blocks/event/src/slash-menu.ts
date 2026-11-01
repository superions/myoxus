// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `slash-menu.ts` - the slash-menu entry that inserts an event
 * block and immediately opens the event-edit dialog through the
 * `MyoxusHostService`.
 *
 * The host creates the workspace event first. Only a successful
 * dialog result inserts the reference block, so cancel and host
 * failures cannot leave empty document content behind.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B (P-VIRG-ARCH-B-02)
 */

import {
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
  editorMessage,
} from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const eventSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-event-insert",
      label: editorMessage("com.myoxus.editor.slash.event", "Event"),
      description: editorMessage(
        "com.myoxus.editor.slash.event-description",
        "Insert a workspace event.",
      ),
      icon: "CalendarClockIcon",
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 9,
      },
      searchAlias: ["event", "calendar"],
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:event"),
      action: async ({ std, model }) => {
        const { host } = std;
        const hostService = std.getOptional(MyoxusHostServiceIdentifier);
        if (
          !hostService ||
          !hasCapability(hostService, MyoxusHostCapability.OpenEventEditDialog)
        ) {
          console.warn(
            "[event-block] host not bound, event insertion cancelled",
          );
          return;
        }
        try {
          const createdEventId = await hostService.openEventEditDialog({
            sourceDocId: host.store.id,
          });
          if (!createdEventId) return;
          const parent = host.store.getParent(model);
          if (!parent) return;
          const index = parent.children.indexOf(model);
          host.store.addBlock(
            "myoxus:event" as never,
            {
              eventId: createdEventId,
              workspaceId: host.store.workspace.id,
            },
            parent,
            index + 1,
          );
        } catch (error) {
          console.warn("[event-block] openEventEditDialog failed", { error });
        }
      },
    },
  ],
};
