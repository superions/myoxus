import {
  editorMessage,
  EditorI18nProvider,
  type EditorI18nMessage,
  resolveEditorMessage,
  ThemeProvider,
} from "@virgultum/shared/services";
import { OpenInNewIcon } from "@myoxus/icons/lit";
import { getEmbedCardIcons } from "@virgultum/block-embed";
import { LoadingIcon, WebIcon16 } from "@virgultum/components/icons";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { ImageProxyService } from "@virgultum/shared/adapters";

import { getHostName } from "@virgultum/shared/utils";
import { isGfxBlockComponent, ShadowlessElement } from "@virgultum/std";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import type { BookmarkBlockComponent } from "../bookmark-block.js";
import { styles } from "../styles.js";

export class BookmarkCard extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.bookmark.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = styles;

  override connectedCallback(): void {
    super.connectedCallback();

    this.disposables.add(
      this.bookmark.model.propsUpdated.subscribe(() => {
        this.requestUpdate();
      }),
    );

    this.disposables.add(
      this.bookmark.std
        .get(ThemeProvider)
        .theme$.subscribe(() => this.requestUpdate()),
    );
  }

  override render() {
    const { url, style } = this.bookmark.model.props;
    const { icon, title, description, image } =
      this.bookmark.linkPreview$.value;

    const cardClassMap = classMap({
      loading: this.loading,
      error: this.error,
      [style]: true,
      selected: this.bookmark.selected$.value,
      edgeless: isGfxBlockComponent(this.bookmark),
      "comment-highlighted": this.bookmark.isCommentHighlighted,
    });

    const domainName = url.match(
      /^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:/\n]+)/im,
    )?.[1];

    const titleText = this.loading
      ? this._text(editorMessage("com.myoxus.loading", "Loading"))
      : !title
        ? this.error
          ? (domainName ??
            this._text(
              editorMessage("com.myoxus.editor.toolbar.card-view", "Card view"),
            ))
          : ""
        : title;

    const theme = this.bookmark.std.get(ThemeProvider).theme;
    const { EmbedCardBannerIcon } = getEmbedCardIcons(theme);
    const imageProxyService = this.bookmark.store.get(ImageProxyService);

    const titleIcon = this.loading
      ? LoadingIcon()
      : icon
        ? html`<img src=${imageProxyService.buildUrl(icon)} alt="icon" />`
        : WebIcon16;

    const descriptionText = this.loading
      ? ""
      : !description
        ? this.error
          ? this._text(
              editorMessage(
                "com.myoxus.editor.link.info-failed",
                "Failed to retrieve link information.",
              ),
            )
          : url
        : (description ?? "");

    const bannerImage =
      !this.loading && image
        ? html`<img src=${imageProxyService.buildUrl(image)} alt="banner" />`
        : EmbedCardBannerIcon;

    return html`
      <div
        class="myoxus-bookmark-card ${cardClassMap}"
        @click=${this.bookmark.handleClick}
        @dblclick=${this.bookmark.handleDoubleClick}
      >
        <div class="myoxus-bookmark-content">
          <div class="myoxus-bookmark-content-title">
            <div class="myoxus-bookmark-content-title-icon">${titleIcon}</div>
            <div class="myoxus-bookmark-content-title-text">${titleText}</div>
          </div>
          <div class="myoxus-bookmark-content-description">
            ${descriptionText}
          </div>
          <div class="myoxus-bookmark-content-url-wrapper">
            <div
              class="myoxus-bookmark-content-url"
              @click=${this.bookmark.open}
            >
              <span>${getHostName(url)}</span>
              <div class="myoxus-bookmark-content-url-icon">
                ${OpenInNewIcon({ width: "12", height: "12" })}
              </div>
            </div>
          </div>
        </div>
        <div class="myoxus-bookmark-banner">${bannerImage}</div>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor bookmark!: BookmarkBlockComponent;

  @property({ attribute: false })
  accessor error!: boolean;

  @property({ attribute: false })
  accessor loading!: boolean;
}

declare global {
  interface HTMLElementTagNameMap {
    "bookmark-card": BookmarkCard;
  }
}
