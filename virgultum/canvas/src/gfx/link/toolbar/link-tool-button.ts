import { insertLinkByQuickSearchCommand } from "@virgultum/embeds/blocks";
import { insertEmbedCard } from "@virgultum/embeds/blocks";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { toggleEmbedCardCreateModal } from "@virgultum/embeds/card-session";
import {
  TelemetryProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";

export class EdgelessLinkToolButton extends QuickToolMixin(LitElement) {
  override createRenderRoot() {
    return this;
  }

  override type = DefaultTool;

  private _onClick() {
    const [success, { insertedLinkType }] = this.edgeless.std.command.exec(
      insertLinkByQuickSearchCommand,
    );

    if (!success) {
      // fallback to create a bookmark block with input modal
      toggleEmbedCardCreateModal(
        this.edgeless.host,
        "Links",
        "The added link will be displayed as a card view.",
        {
          mode: "edgeless",
          onSave: (url) => {
            insertEmbedCard(this.edgeless.std, {
              flavour: "myoxus:bookmark",
              targetStyle: "vertical",
              props: { url },
            });
          },
        },
        ({ mode }) => {
          if (mode === "edgeless") {
            const gfx = this.edgeless.std.get(GfxControllerIdentifier);
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

        this.edgeless.std
          .getOptional(TelemetryProvider)
          ?.track("CanvasElementAdded", {
            control: "toolbar:general",
            page: "whiteboard editor",
            module: "toolbar",
            segment: "toolbar",
            type: flavour.split(":")[1],
          });

        this.edgeless.std
          .getOptional(TelemetryProvider)
          ?.track("LinkedDocCreated", {
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

  override render() {
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      action: {
        id: "canvas-link",
        icon: "LinkIcon",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.keyboard.link", "Link"),
          this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        shortcut: "@",
        disabled: false,
        run: () => this._onClick(),
      },
    });
  }
}
