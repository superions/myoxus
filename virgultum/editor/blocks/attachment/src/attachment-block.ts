import {
  editorMessage,
  BlockElementCommentManager,
  CitationProvider,
  EditorChromeHostIdentifier,
  DocModeProvider,
  FileSizeLimitProvider,
  TelemetryProvider,
  EditorI18nProvider,
} from "@virgultum/shared/services";
import { AttachmentIcon, WarningIcon } from "@myoxus/icons/lit";
import { batch, computed, signal } from "@preact/signals-core";
import {
  CaptionedBlockComponent,
  SelectedStyle,
} from "@virgultum/components/caption";
import {
  getAttachmentFileIcon,
  LoadingIcon,
} from "@virgultum/components/icons";
import { Peekable } from "@virgultum/components/peek";
import { ResourceController } from "@virgultum/components/resource";
import {
  type AttachmentBlockModel,
  AttachmentBlockStyles,
} from "@virgultum/model";

import {
  editorToast,
  formatSize,
  openSingleFileWith,
} from "@virgultum/shared/utils";

import { BlockSelection, isGfxBlockComponent } from "@virgultum/std";
import { nanoid, Slice } from "@virgultum/store";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { guard } from "lit/directives/guard.js";
import { styleMap } from "lit/directives/style-map.js";
import { when } from "lit/directives/when.js";
import { filter } from "rxjs/operators";

import { AttachmentEmbedProvider } from "./embed";
import { styles } from "./styles";
import { downloadAttachmentBlob, getFileType, refreshData } from "./utils";

@Peekable({
  enableOn: ({ model }: AttachmentBlockComponent) => {
    return !model.store.readonly && model.props.type.endsWith("pdf");
  },
})
export class AttachmentBlockComponent extends CaptionedBlockComponent<AttachmentBlockModel> {
  static override styles = styles;

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

  protected containerStyleMap = styleMap({
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
    this._disposables.add(
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

  override connectedCallback() {
    super.connectedCallback();

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
  }

  override firstUpdated() {
    // lazy bindings
    this.disposables.addFromEvent(this, "click", this.onClick);
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
    const resolvedState = this.resourceController.resolveStateWith({
      loadingIcon: LoadingIcon(),
      errorIcon: WarningIcon(),
      icon: AttachmentIcon(),
      title: name,
      description: formatSize(size),
    });

    return resolvedState;
  });

  protected renderCardView = () => {
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
    return this.std.get(EditorChromeHostIdentifier).renderAttachmentCard({
      inSurface: isGfxBlockComponent(this),
      selected: this.selected$.value,
      title: title ?? "",
      description: description ?? "",
      fileType: this.filetype,
      loading,
      error,
      vertical: cardStyle === "cubeThick",
      action,
    });
  };

  protected renderEmbedView = () => {
    const { model, blobUrl } = this;
    if (!model.props.embed$.value || !blobUrl) return null;

    const { std, _maxFileSize } = this;
    const provider = std.get(AttachmentEmbedProvider);

    const render = provider.getRender(model, _maxFileSize);
    if (!render) return null;

    const enabled = provider.shouldShowStatus(model);

    return html`
      <div class="myoxus-attachment-embed-container">
        ${guard([this._refreshKey$.value], () => render(model, blobUrl))}
      </div>
      ${when(enabled, () => {
        const resolvedState = this.resolvedState$.value;
        if (resolvedState.state !== "error") return null;
        // It should be an error messge.
        const message = resolvedState.description;
        if (!message) return null;

        const needUpload = resolvedState.needUpload;
        const action = () =>
          needUpload ? this.resourceController.upload() : this.reload();

        return html`
          <myoxus-resource-status
            .i18n=${this.std.getOptional(EditorI18nProvider) ?? undefined}
            class="myoxus-attachment-embed-status"
            .message=${message}
            .needUpload=${needUpload}
            .action=${action}
          ></myoxus-resource-status>
        `;
      })}
    `;
  };

  private readonly _renderCitation = () => {
    const { name, footnoteIdentifier } = this.model.props;
    const icon = getAttachmentFileIcon(this.filetype);

    return html`<myoxus-citation-card
      .icon=${icon}
      .citationTitle=${name}
      .citationIdentifier=${footnoteIdentifier}
      .active=${this.selected$.value}
    ></myoxus-citation-card>`;
  };

  override renderBlock() {
    return html`
      <div
        class=${classMap({
          "myoxus-attachment-container": true,
          "comment-highlighted": this.isCommentHighlighted,
        })}
        style=${this.containerStyleMap}
      >
        ${when(
          this.isCitation,
          () => this._renderCitation(),
          () => this.renderEmbedView() ?? this.renderCardView(),
        )}
      </div>
    `;
  }

  override accessor selectedStyle = SelectedStyle.Border;

  override accessor useCaptionEditor = true;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-attachment": AttachmentBlockComponent;
  }
}
