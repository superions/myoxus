import { editorMessage, TelemetryProvider } from "@virgultum/shared/services";
import { insertLinkByQuickSearchCommand } from "@virgultum/block-bookmark";
import { menu } from "@virgultum/components/context-menu";
import { LinkIcon } from "@virgultum/components/icons";

import type { DenseMenuBuilder } from "@virgultum/widget-edgeless-toolbar";

export const buildLinkDenseMenu: DenseMenuBuilder = (edgeless) =>
  menu.action({
    name: "Link",
    label: editorMessage("com.myoxus.editor.keyboard.link", "Link"),
    prefix: LinkIcon,
    select: () => {
      const [_, { insertedLinkType }] = edgeless.std.command.exec(
        insertLinkByQuickSearchCommand,
      );

      insertedLinkType
        ?.then((type) => {
          const flavour = type?.flavour;
          if (!flavour) return;

          edgeless.std
            .getOptional(TelemetryProvider)
            ?.track("CanvasElementAdded", {
              control: "toolbar:general",
              page: "whiteboard editor",
              module: "toolbar",
              type: flavour.split(":")[1],
            });
        })
        .catch(console.error);
    },
  });
