import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  insertEmbedCard,
  insertLinkByQuickSearchCommand,
} from "@virgultum/embeds/blocks";
import { toggleEmbedCardCreateModal } from "@virgultum/embeds/card-session";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EditorI18nProvider,
  TelemetryProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { QuickToolExtension } from "../../widgets/edgeless-toolbar/index";
import { buildLinkDenseMenu } from "./toolbar/link-dense-menu";

function openLink(block: BlockComponent) {
  const [success, { insertedLinkType }] = block.std.command.exec(
    insertLinkByQuickSearchCommand,
  );

  if (!success) {
    // fallback to create a bookmark block with input modal
    toggleEmbedCardCreateModal(
      block.host,
      "Links",
      "The added link will be displayed as a card view.",
      {
        mode: "edgeless",
        onSave: (url) => {
          insertEmbedCard(block.std, {
            flavour: "myoxus:bookmark",
            targetStyle: "vertical",
            props: { url },
          });
        },
      },
      ({ mode }) => {
        if (mode === "edgeless") {
          const gfx = block.std.get(GfxControllerIdentifier);
          gfx.tool.setTool(DefaultTool);
        }
      },
    ).catch(console.error);
    return;
  }

  insertedLinkType
    ?.then((type) => {
      const flavour = type?.flavour;
      if (!flavour) return;

      block.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "toolbar:general",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: flavour.split(":")[1],
      });

      block.std.getOptional(TelemetryProvider)?.track("LinkedDocCreated", {
        control: "links",
        page: "whiteboard editor",
        module: "edgeless toolbar",
        segment: "whiteboard",
        type: flavour.split(":")[1],
        other: "existing doc",
      });
    })
    .catch(console.error);
}

export const linkQuickTool = QuickToolExtension("link", ({ block, gfx }) => ({
  content: {
    type: "control",
    controls: {
      action: {
        id: "canvas-link",
        icon: "LinkIcon",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.keyboard.link", "Link"),
          block.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        shortcut: "@",
        disabled: false,
        run: () => openLink(block),
      },
    },
  },
  menu: buildLinkDenseMenu(block, gfx),
}));
