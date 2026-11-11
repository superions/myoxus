import type { EmbedIframeBlockModel } from "@virgultum/model";
import {
  DocModeProvider,
  TelemetryProvider,
  EditorI18nProvider,
  EmbedIframeService,
  NotificationProvider,
  resolveLegacyEditorText,
} from "@virgultum/shared/services";
import { isValidUrl } from "@virgultum/shared/utils";
import {
  BlockSelection,
  type BlockStdScope,
  SurfaceSelection,
} from "@virgultum/std";

/** Retained editor mutation and telemetry; the native form owns input and focus. */
export class EmbedIframeLinkInputBase {
  constructor(
    readonly std: BlockStdScope,
    readonly model: EmbedIframeBlockModel,
    readonly abortController: AbortController,
    readonly inSurface: boolean,
    readonly editing: boolean,
    readonly telemetrySegment = "editor",
  ) {}

  protected track(status: "success" | "failure") {
    this.std
      .getOptional(TelemetryProvider)
      ?.track(this.editing ? "EditLink" : "CreateEmbedBlock", {
        type: "embed iframe block",
        page:
          this.std.get(DocModeProvider).getEditorMode() === "edgeless"
            ? "whiteboard editor"
            : "doc editor",
        segment: this.telemetrySegment,
        module: "embed block",
        control: this.editing ? "edit button" : "confirm embed link",
        result: status,
      });
  }

  protected tryToAddBookmark(url: string) {
    if (!isValidUrl(url)) {
      const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
      const text = (value: string) =>
        resolveLegacyEditorText(value, i18n) ?? value;
      this.notificationService?.notify({
        title: text("Invalid URL"),
        message: text("Please enter a valid URL"),
        accent: "error",
        onClose: function (): void {},
      });
      return;
    }

    const { model } = this;
    const { parent } = model;
    const index = parent?.children.indexOf(model);
    const flavour = "myoxus:bookmark";

    this.store.transact(() => {
      const blockId = this.store.addBlock(flavour, { url }, parent, index);
      this.store.deleteBlock(model);
      if (this.inSurface) {
        this.std.selection.setGroup("gfx", [
          this.std.selection.create(
            SurfaceSelection,
            blockId,
            [blockId],
            false,
          ),
        ]);
      } else {
        this.std.selection.setGroup("note", [
          this.std.selection.create(BlockSelection, { blockId }),
        ]);
      }
    });

    this.abortController?.abort();
  }

  async confirm(url: string) {
    if (
      !url.trim() ||
      this.abortController.signal.aborted ||
      this.store.readonly ||
      this.store.getBlock(this.model.id)?.model !== this.model
    ) {
      return;
    }

    try {
      const embedIframeService = this.std.get(EmbedIframeService);
      if (!embedIframeService) {
        console.error("iframe EmbedIframeService not found");
        this.track("failure");
        return;
      }

      const canEmbed = embedIframeService.canEmbed(url);

      if (!canEmbed) {
        console.log("iframe can not be embedded, add as a bookmark", url);
        this.tryToAddBookmark(url);
        return;
      }

      this.store.updateBlock(this.model, {
        url,
        iframeUrl: "",
        title: "",
        description: "",
      });
      this.track("success");
    } catch (error) {
      this.track("failure");
      const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
      const text = (value: string) =>
        resolveLegacyEditorText(value, i18n) ?? value;
      this.notificationService?.notify({
        title: text("Error in embed iframe creation"),
        message:
          error instanceof Error ? error.message : text("Please try again"),
        accent: "error",
        onClose: function (): void {},
      });
    } finally {
      this.abortController?.abort();
    }
  }

  get store() {
    return this.model.store;
  }
  get notificationService() {
    return this.std.getOptional(NotificationProvider);
  }
}
