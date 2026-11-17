import {
  editorMessage,
  TelemetryProvider,
  EditorI18nProvider,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { insertLinkByQuickSearchCommand } from "@virgultum/embeds/blocks";

import type { DenseMenuBuilder } from "../../../widgets/edgeless-toolbar/index";

export const buildLinkDenseMenu: DenseMenuBuilder = (edgeless) => ({
  id: "canvas-overflow-link",
  label: resolveEditorMessage(
    editorMessage("com.myoxus.editor.keyboard.link", "Link"),
    edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
  ),
  icon: "LinkIcon",
  disabled: edgeless.store.readonly,
  run: () => {
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
