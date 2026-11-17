import { SignalWatcher } from "@virgultum/core/primitives/lit";
import { effect } from "@preact/signals-core";
import { addAttachments } from "@virgultum/embeds/blocks";
import { insertLinkByQuickSearchCommand } from "@virgultum/embeds/blocks";
import { addImages } from "@virgultum/embeds/blocks";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { MAX_IMAGE_WIDTH } from "@virgultum/core/models";
import {
  TelemetryProvider,
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import type { NoteChildrenFlavour } from "@virgultum/core/types";
import {
  getImageFilesFromLocal,
  openSingleFileWith,
} from "@virgultum/core/utils";
import type { ToolOptions } from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";
import { property, state } from "lit/decorators.js";

import { NoteTool, type NoteToolOption } from "../note-tool.js";
import { NOTE_MENU_ITEMS } from "./note-menu-config.js";

export class EdgelessNoteMenu extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  override createRenderRoot() {
    return this;
  }

  override type = NoteTool;

  private async _addImages() {
    this._imageLoading = true;
    const imageFiles = await getImageFilesFromLocal();
    const ids = await addImages(this.edgeless.std, imageFiles, {
      maxWidth: MAX_IMAGE_WIDTH,
    });
    this._imageLoading = false;
    this.gfx.tool.setTool(DefaultTool);
    this.gfx.selection.set({ elements: ids });
  }

  private _onHandleLinkButtonClick() {
    const [_, { insertedLinkType }] = this.edgeless.service.std.command.exec(
      insertLinkByQuickSearchCommand,
    );

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
            type: flavour.split(":")[1],
          });
      })
      .catch(console.error);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
  }

  override firstUpdated() {
    this.disposables.add(
      effect(() => {
        const tool = this.gfx.tool.currentToolOption$.value;

        if (tool?.toolType !== NoteTool) return;
        const options = tool.options as ToolOptions<NoteTool>;
        this.childFlavour = options.childFlavour;
        this.childType = options.childType;
        this.tip = options.tip;
      }),
    );
  }

  override render() {
    const { childType } = this;

    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasMenu({
      tools: [
        {
          action: {
            id: "canvas-note-image",
            icon: "ImageIcon",
            label: this._text(editorMessage("Image", "Image")),
            disabled: this._imageLoading,
            run: () => {
              void this._addImages();
            },
          },
        },
        {
          action: {
            id: "canvas-note-link",
            icon: "LinkIcon",
            label: this._text(
              editorMessage("com.myoxus.editor.keyboard.link", "Link"),
            ),
            shortcut: "@",
            disabled: false,
            run: () => this._onHandleLinkButtonClick(),
          },
        },
        {
          action: {
            id: "canvas-note-attachment",
            icon: "AttachmentIcon",
            label: this._text(
              editorMessage("com.myoxus.editor.slash.attachment", "File"),
            ),
            disabled: false,
            run: () => {
              void this._addAttachment();
            },
          },
        },
        ...NOTE_MENU_ITEMS.map((item, index) => ({
          action: {
            id: `canvas-note-${item.childFlavour}-${item.childType}`,
            label: this._text(item.tooltip),
            disabled: false,
            active: childType === item.childType,
            run: () =>
              this.onChange({
                childFlavour: item.childFlavour,
                childType: item.childType,
                tip: this._text(item.tooltip),
              }),
          },
          artwork: item.icon,
          separatorBefore: index === 0,
        })),
      ],
      actions: [],
    });
  }

  private async _addAttachment() {
    const file = await openSingleFileWith();
    if (!file) return;
    await addAttachments(this.edgeless.std, [file]);
    this.gfx.tool.setTool(DefaultTool);
    this.edgeless.std
      .getOptional(TelemetryProvider)
      ?.track("CanvasElementAdded", {
        control: "toolbar:general",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: "attachment",
      });
  }

  @state()
  private accessor _imageLoading = false;

  @property({ attribute: false })
  accessor childFlavour!: NoteChildrenFlavour;

  @property({ attribute: false })
  accessor childType!: string | null;

  @property({ attribute: false })
  accessor onChange!: (
    props: Partial<{
      childFlavour: NoteToolOption["childFlavour"];
      childType: string | null;
      tip: string;
    }>,
  ) => void;

  @property({ attribute: false })
  accessor tip!: string;
}
