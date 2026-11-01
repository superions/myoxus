import {
  editorMessage,
  EditorI18nProvider,
  type EditorI18nMessage,
  resolveEditorMessage,
  DocDisplayMetaProvider,
} from "@virgultum/shared/services";
import { consume } from "@lit/context";
import { LinkedPageIcon } from "@myoxus/icons/lit";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { noop } from "@virgultum/global/utils";
import type {
  AttachmentBlockModel,
  BookmarkBlockModel,
  CodeBlockModel,
  ImageBlockModel,
  ListBlockModel,
  ParagraphBlockModel,
  RootBlockModel,
} from "@virgultum/model";

import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { ShadowlessElement } from "@virgultum/std";
import type { BlockModel, DeltaInsert } from "@virgultum/store";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import {
  placeholderMap,
  previewIconMap,
  type TocContext,
  tocContext,
} from "../config.js";
import { isHeadingBlock, isRootBlock } from "../utils/query.js";
import * as styles from "./outline-preview.styles";

function assertType<T>(value: unknown): asserts value is T {
  noop(value);
}

export const MYOXUS_OUTLINE_BLOCK_PREVIEW = "myoxus-outline-block-preview";

export class OutlineBlockPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this._context.editor$.value.std.getOptional(EditorI18nProvider) ??
        undefined,
    );
  }

  private get _docDisplayMetaService() {
    return this._context.editor$.value.std.get(DocDisplayMetaProvider);
  }

  private _TextBlockPreview(block: ParagraphBlockModel | ListBlockModel) {
    const deltas: DeltaInsert<MyoxusTextAttributes>[] =
      block.props.text.yText.toDelta();
    if (!block.props.text.length) return nothing;
    const iconClass = this.disabledIcon ? styles.iconDisabled : styles.icon;

    const previewText = deltas.map((delta) => {
      if (delta.attributes?.reference) {
        // If linked doc, render linked doc icon and the doc title.
        const refAttribute = delta.attributes.reference;
        const refMeta = block.store.workspace.meta.docMetas.find(
          (doc) => doc.id === refAttribute.pageId,
        );
        const unavailable = !refMeta;

        const icon = unavailable
          ? LinkedPageIcon({ width: "1.1em", height: "1.1em" })
          : this._docDisplayMetaService.icon(refMeta.id).value;
        const title = unavailable
          ? "Deleted doc"
          : this._docDisplayMetaService.title(refMeta.id).value;

        return html`<span
          class=${classMap({
            [styles.linkedDocPreviewUnavailable]: unavailable,
            [styles.linkedDocPreviewAvailable]: !unavailable,
          })}
        >
          ${icon}
          <span
            class=${classMap({
              [styles.linkedDocText]: true,
              [styles.linkedDocTextUnavailable]: unavailable,
            })}
            >${title.length ? title : this._text(editorMessage("Untitled", "Untitled"))}</span
          ></span
        >`;
      } else {
        // If not linked doc, render the text.
        return delta.insert.toString().trim().length > 0
          ? html`<span class=${styles.textSpan}
              >${delta.insert.toString()}</span
            >`
          : nothing;
      }
    });

    const headingClass =
      block.props.type in styles.subtypeStyles
        ? styles.subtypeStyles[
            block.props.type as keyof typeof styles.subtypeStyles
          ]
        : "";

    return html`<span
        data-testid="outline-block-preview-${block.props.type}"
        class="${styles.text} ${styles.textGeneral} ${headingClass}"
        >${previewText}</span
      >
      ${
        this._context.showIcons$.value
          ? html`<span class=${iconClass}
              >${previewIconMap[block.props.type]}</span
            >`
          : nothing
      }`;
  }

  override render() {
    return html`<div class=${styles.outlineBlockPreview}>
      ${this.renderBlockByFlavour()}
    </div>`;
  }

  renderBlockByFlavour() {
    const { block } = this;
    const iconClass = this.disabledIcon ? styles.iconDisabled : styles.icon;

    if (
      !this._context.enableSorting$.value &&
      !isHeadingBlock(block) &&
      !isRootBlock(block)
    )
      return nothing;

    const showPreviewIcon = this._context.showIcons$.value;

    switch (block.flavour) {
      case "myoxus:page":
        assertType<RootBlockModel>(block);
        return block.props.title.length > 0
          ? html`<span
              data-testid="outline-block-preview-title"
              class="${styles.text} ${styles.subtypeStyles.title}"
            >
              ${block.props.title$.value}
            </span>`
          : nothing;
      case "myoxus:paragraph":
        assertType<ParagraphBlockModel>(block);
        return this._TextBlockPreview(block);
      case "myoxus:list":
        assertType<ListBlockModel>(block);
        return this._TextBlockPreview(block);
      case "myoxus:bookmark":
        assertType<BookmarkBlockModel>(block);
        return html`
          <span class="${styles.text} ${styles.textGeneral}"
            >${
              block.props.title || block.props.url || placeholderMap["bookmark"]
            }</span
          >
          ${
            showPreviewIcon
              ? html`<span class=${iconClass}
                  >${previewIconMap["bookmark"]}</span
                >`
              : nothing
          }
        `;
      case "myoxus:code":
        assertType<CodeBlockModel>(block);
        return html`
          <span class="${styles.text} ${styles.textGeneral}"
            >${block.props.language ?? placeholderMap["code"]}</span
          >
          ${
            showPreviewIcon
              ? html`<span class=${iconClass}>${previewIconMap["code"]}</span>`
              : nothing
          }
        `;
      case "myoxus:database":
        return html`
          <span class="${styles.text} ${styles.textGeneral}"
            >${placeholderMap["database"]}</span
          >
          ${
            showPreviewIcon
              ? html`<span class=${iconClass}>${previewIconMap["table"]}</span>`
              : nothing
          }
        `;
      case "myoxus:image":
        assertType<ImageBlockModel>(block);
        return html`
          <span class="${styles.text} ${styles.textGeneral}"
            >${
              block.props.caption?.length
                ? block.props.caption
                : placeholderMap["image"]
            }</span
          >
          ${
            showPreviewIcon
              ? html`<span class=${iconClass}>${previewIconMap["image"]}</span>`
              : nothing
          }
        `;
      case "myoxus:attachment":
        assertType<AttachmentBlockModel>(block);
        return html`
          <span class="${styles.text} ${styles.textGeneral}"
            >${
              block.props.name?.length
                ? block.props.name
                : placeholderMap["attachment"]
            }</span
          >
          ${
            showPreviewIcon
              ? html`<span class=${iconClass}
                  >${previewIconMap["attachment"]}</span
                >`
              : nothing
          }
        `;
      default:
        return nothing;
    }
  }

  @property({ attribute: false })
  accessor block!: BlockModel;

  @property({ attribute: false })
  accessor disabledIcon = false;

  @consume({ context: tocContext })
  private accessor _context!: TocContext;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_BLOCK_PREVIEW]: OutlineBlockPreview;
  }
}
