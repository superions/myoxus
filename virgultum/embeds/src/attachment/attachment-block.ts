import {
  editorMessage,
  resolveEditorMessage,
  BlockElementCommentManager,
  CitationProvider,
  EditorChromeHostIdentifier,
  type EditorAttachmentCardControls,
  DocModeProvider,
  FileSizeLimitProvider,
  TelemetryProvider,
  EditorI18nProvider,
} from "@virgultum/core/services";
import {
  batch,
  computed,
  effect,
  signal,
  untracked,
} from "@preact/signals-core";
import {
  NativeCaptionedBlockComponent,
  SelectedStyle,
  type BlockStyleMap,
} from "@virgultum/content/caption";
import { Peekable } from "@virgultum/core/view/peek";
import { ResourceController } from "@virgultum/core/resource";
import {
  type AttachmentBlockModel,
  AttachmentBlockStyles,
} from "@virgultum/core/models";

import {
  editorToast,
  formatSize,
  openSingleFileWith,
} from "@virgultum/core/utils";

import { BlockSelection, isGfxBlockComponent } from "@virgultum/core/runtime";
import { nanoid, Slice } from "@virgultum/core/store";
import { filter } from "rxjs/operators";

import { AttachmentEmbedProvider } from "./embed";
import { styles } from "./styles";
import { downloadAttachmentBlob, getFileType, refreshData } from "./utils";

@Peekable({
  enableOn: ({ model }: AttachmentBlockComponent) => {
    return !model.store.readonly && model.props.type.endsWith("pdf");
  },
})
export class AttachmentBlockComponent extends NativeCaptionedBlockComponent<AttachmentBlockModel> {
  protected override blockStyles = styles;
  protected override useCaptionEditor = true;

  blockDraggable = true;

  resourceController = new ResourceController(
    computed(() => this.model.props.sourceId$.value),
  );

  get blobUrl() {
    return this.resourceController.blobUrl$.value;
  }

  get filetype() {
    const name = this.model.props.name$.value;
    return name.split(".").pop() ?? "";
  }

  protected readonly containerStyle$ = signal<BlockStyleMap>({
    position: "relative",
    width: "100%",
    margin: "18px 0px",
  });

  private get _maxFileSize() {
    return this.std.get(FileSizeLimitProvider).maxFileSize;
  }

  get citationService() {
    return this.std.get(CitationProvider);
  }

  get isCitation() {
    return this.citationService.isCitationModel(this.model);
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  convertTo = () => {
    return this.std
      .get(AttachmentEmbedProvider)
      .convertTo(this.model, this._maxFileSize);
  };

  copy = () => {
    const slice = Slice.fromModels(this.store, [this.model]);
    this.std.clipboard.copySlice(slice).catch(console.error);
    editorToast(
      this.host,
      editorMessage("Copied to clipboard", "Copied to clipboard"),
    );
  };

  download = () => {
    downloadAttachmentBlob(this);
  };

  embedded = () => {
    return (
      Boolean(this.blobUrl) &&
      this.std
        .get(AttachmentEmbedProvider)
        .embedded(this.model, this._maxFileSize)
    );
  };

  open = () => {
    const blobUrl = this.blobUrl;
    if (!blobUrl) return;
    window.open(blobUrl, "_blank");
  };

  // Refreshes data.
  refreshData = () => {
    refreshData(this).catch(console.error);
  };

  private readonly _refreshKey$ = signal<string | null>(null);

  // Refreshes the embed component.
  reload = () => {
    batch(() => {
      if (this.model.props.embed$.value) {
        this._refreshKey$.value = nanoid();
        return;
      }

      this.refreshData();
    });
  };

  // Replaces the current attachment.
  replace = async () => {
    const state = this.resourceController.state$.peek();
    if (state.uploading) return;

    const file = await openSingleFileWith();
    if (!file) return;

    const sourceId = await this.std.store.blobSync.set(file);
    const type = await getFileType(file);
    const { name, size } = file;

    let embed = this.model.props.embed$.value ?? false;

    this.std.store.captureSync();
    this.std.store.transact(() => {
      this.std.store.updateBlock(this.blockId, {
        name,
        size,
        type,
        sourceId,
        embed: false,
      });

      const provider = this.std.get(AttachmentEmbedProvider);
      embed &&= provider.embedded(this.model);

      if (embed) {
        provider.convertTo(this.model);
      }

      // Reloads
      this.reload();
    });
  };

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  private readonly _trackCitationDeleteEvent = () => {
    // Check citation delete event
    this.disposables.add(
      this.std.store.slots.blockUpdated
        .pipe(
          filter((payload) => {
            if (!payload.isLocal) return false;

            const { flavour, id, type } = payload;
            if (
              type !== "delete" ||
              flavour !== this.model.flavour ||
              id !== this.model.id
            )
              return false;

            const { model } = payload;
            if (!this.citationService.isCitationModel(model)) return false;

            return true;
          }),
        )
        .subscribe(() => {
          this.citationService.trackEvent("Delete");
        }),
    );
  };

  constructor() {
    super();
    this.selectedStyle$.value = SelectedStyle.Border;
  }

  protected onClick(event: MouseEvent) {
    // the peek view need handle shift + click
    if (event.defaultPrevented) return;

    event.stopPropagation();

    if (!this.selected$.peek()) {
      this._selectBlock();
    }
  }

  protected resolvedState$ = computed(() => {
    const size = this.model.props.size;
    const name = this.model.props.name$.value;
    return this.resourceController.resolveStateWith({
      title: name,
      description: formatSize(size),
    });
  });

  private buildCardControls(): EditorAttachmentCardControls {
    void this.revision$.value;
    const resolvedState = this.resolvedState$.value;
    const cardStyle = this.model.props.style$.value ?? AttachmentBlockStyles[1];

    const { title, description, loading, error, state, needUpload } =
      resolvedState;
    const overSize = this.std.get(FileSizeLimitProvider).onOverFileSize;
    const action =
      state === "error:oversize"
        ? !this.store.readonly && overSize
          ? { kind: "limit" as const, run: overSize }
          : undefined
        : state === "error"
          ? {
              kind: needUpload ? ("retry" as const) : ("reload" as const),
              run: () => {
                if (!this.isConnected) return;
                if (needUpload)
                  this.resourceController.upload().catch(console.error);
                else this.refreshData();
                const mode =
                  this.std.get(DocModeProvider).getEditorMode() ?? "page";
                const segment = mode === "page" ? "doc" : "whiteboard";
                this.std
                  .getOptional(TelemetryProvider)
                  ?.track("AttachmentReloadedEvent", {
                    segment,
                    page: `${segment} editor`,
                    module: "attachment",
                    control: needUpload ? "retry" : "reload",
                    category: "card",
                    type: this.filetype,
                  });
              },
            }
          : undefined;
    return {
      inSurface: isGfxBlockComponent(this),
      selected: this.selected$.value,
      title: title ?? "",
      description: description ?? "",
      fileType: this.filetype,
      loading,
      error,
      vertical: cardStyle === "cubeThick",
      action,
    };
  }

  private buildCitationControls(): EditorAttachmentCardControls {
    void this.revision$.value;
    const { name, footnoteIdentifier } = this.model.props;
    return {
      inSurface: isGfxBlockComponent(this),
      selected: this.selected$.value,
      title: name,
      description: "",
      fileType: this.filetype,
      loading: false,
      error: false,
      vertical: false,
      citationIdentifier: footnoteIdentifier ?? undefined,
    };
  }

  private buildStatusControls(): EditorAttachmentCardControls | null {
    void this.revision$.value;
    const resolvedState = this.resolvedState$.value;
    if (resolvedState.state !== "error") return null;
    const message = resolvedState.description;
    if (!message) return null;
    const needUpload = resolvedState.needUpload;
    return {
      inSurface: isGfxBlockComponent(this),
      selected: this.selected$.value,
      title: resolveEditorMessage(
        needUpload
          ? editorMessage(
              "com.myoxus.editor.resource.upload-failed",
              "Upload failed",
            )
          : editorMessage(
              "com.myoxus.editor.resource.download-failed",
              "Download failed",
            ),
        this.std.getOptional(EditorI18nProvider) ?? undefined,
      ),
      description: message,
      fileType: this.filetype,
      loading: false,
      error: true,
      vertical: false,
      statusPopover: true,
      action: {
        kind: needUpload ? "retry" : "reload",
        run: () =>
          needUpload ? this.resourceController.upload() : this.reload(),
      },
    };
  }

  protected override mountBlock(container: HTMLElement) {
    this.contentEditable = "false";

    this.resourceController.setEngine(this.std.store.blobSync);
    this.disposables.add(this.resourceController.subscribe());
    this.disposables.add(this.resourceController);
    this.disposables.add(
      this.model.props.sourceId$.subscribe(() => {
        this.refreshData();
      }),
    );

    if (!this.model.props.style && !this.store.readonly) {
      this.store.withoutTransact(() => {
        this.store.updateBlock(this.model, {
          style: AttachmentBlockStyles[1],
        });
      });
    }

    this._trackCitationDeleteEvent();
    this.disposables.addFromEvent(this, "click", (event: MouseEvent) =>
      this.onClick(event),
    );

    const doc = this.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "myoxus-attachment-container";
    container.replaceChildren(wrapper);

    let appliedKeys: string[] = [];
    this.disposables.add(
      effect(() => {
        void this.revision$.value;
        wrapper.classList.toggle(
          "comment-highlighted",
          this.isCommentHighlighted,
        );
        const style = this.containerStyle$.value;
        for (const key of appliedKeys) {
          if (style[key] === undefined) {
            wrapper.style.setProperty(
              key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
              "",
            );
          }
        }
        appliedKeys = [];
        for (const [key, value] of Object.entries(style)) {
          if (value !== undefined) {
            (wrapper.style as unknown as Record<string, string>)[key] = value;
            appliedKeys.push(key);
          }
        }
      }),
    );

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);

    this.disposables.add(
      effect(() => {
        const isCitation = this.isCitation;
        const embed = Boolean(this.model.props.embed$.value);
        const blobUrl = this.blobUrl;
        const refreshKey = this._refreshKey$.value;
        const provider = this.std.get(AttachmentEmbedProvider);
        const mountFn =
          !isCitation && embed && blobUrl
            ? provider.getMount(this.model, this._maxFileSize)
            : null;
        void refreshKey;

        return untracked(() => {
          if (isCitation) {
            if (!chrome) return;
            const host = doc.createElement("div");
            host.style.display = "contents";
            wrapper.replaceChildren(host);
            const state = computed(() => this.buildCitationControls());
            const unmount = chrome.mountAttachmentCard(host, state);
            return () => {
              unmount();
              host.remove();
            };
          }

          if (mountFn && blobUrl) {
            const embedContainer = doc.createElement("div");
            embedContainer.className = "myoxus-attachment-embed-container";
            wrapper.replaceChildren(embedContainer);
            const releaseEmbed = mountFn(embedContainer, this.model, blobUrl);

            let releaseStatus: (() => void) | undefined;
            if (
              provider.shouldShowStatus(this.model, this._maxFileSize) &&
              chrome
            ) {
              const statusEl = doc.createElement("span");
              statusEl.className = "myoxus-attachment-embed-status";
              const statusState = computed(() => this.buildStatusControls());
              const stopStatus = effect(() => {
                const active = Boolean(statusState.value);
                if (active && !statusEl.parentNode) wrapper.append(statusEl);
                else if (!active && statusEl.parentNode) statusEl.remove();
              });
              const unmountStatus = chrome.mountAttachmentCard(
                statusEl,
                statusState,
              );
              releaseStatus = () => {
                stopStatus();
                unmountStatus();
                statusEl.remove();
              };
            }

            return () => {
              releaseStatus?.();
              releaseEmbed();
              embedContainer.remove();
            };
          }

          if (!chrome) return;
          const host = doc.createElement("div");
          host.style.display = "contents";
          wrapper.replaceChildren(host);
          const state = computed(() => this.buildCardControls());
          const unmount = chrome.mountAttachmentCard(host, state);
          return () => {
            unmount();
            host.remove();
          };
        });
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-attachment": AttachmentBlockComponent;
  }
}
