import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { noop } from "@virgultum/global/utils";
import type { EmbedIframeBlockModel } from "@virgultum/model";
import {
  EditorI18nProvider,
  EmbedIframeService,
  NotificationProvider,
  resolveLegacyEditorText,
} from "@virgultum/shared/services";
import { isValidUrl, stopPropagation } from "@virgultum/shared/utils";
import {
  BlockSelection,
  type BlockStdScope,
  SurfaceSelection,
} from "@virgultum/std";
import { LitElement } from "lit";
import { property, query, state } from "lit/decorators.js";

export class EmbedIframeLinkInputBase extends SignalWatcher(
  WithDisposable(LitElement),
) {
  // this method is used to track the event when the user inputs the link
  // it should be overridden by the subclass
  protected track(status: "success" | "failure") {
    noop(status);
  }

  protected isInputEmpty() {
    return this._linkInputValue.trim() === "";
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

  protected async onConfirm() {
    if (this.isInputEmpty()) {
      return;
    }

    try {
      const embedIframeService = this.std.get(EmbedIframeService);
      if (!embedIframeService) {
        console.error("iframe EmbedIframeService not found");
        this.track("failure");
        return;
      }

      const url = this._linkInputValue;
      const canEmbed = embedIframeService.canEmbed(url);

      if (!canEmbed) {
        console.log("iframe can not be embedded, add as a bookmark", url);
        this.tryToAddBookmark(url);
        return;
      }

      this.store.updateBlock(this.model, {
        url: this._linkInputValue,
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

  protected handleInput = (e: InputEvent) => {
    const target = e.target as HTMLInputElement;
    this._linkInputValue = target.value;
  };

  protected handleKeyDown = async (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) {
      await this.onConfirm();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.updateComplete
      .then(() => {
        requestAnimationFrame(() => {
          this.input.focus();
        });
      })
      .catch(console.error);
    this.disposables.addFromEvent(this, "cut", stopPropagation);
    this.disposables.addFromEvent(this, "copy", stopPropagation);
    this.disposables.addFromEvent(this, "paste", stopPropagation);
    this.disposables.addFromEvent(this, "pointerdown", stopPropagation);
  }

  get store() {
    return this.model.store;
  }

  get notificationService() {
    return this.std.getOptional(NotificationProvider);
  }

  @state()
  protected accessor _linkInputValue = "";

  @query("input")
  accessor input!: HTMLInputElement;

  @property({ attribute: false })
  accessor model!: EmbedIframeBlockModel;

  @property({ attribute: false })
  accessor std!: BlockStdScope;

  @property({ attribute: false })
  accessor abortController: AbortController | undefined = undefined;

  @property({ attribute: false })
  accessor inSurface = false;
}
