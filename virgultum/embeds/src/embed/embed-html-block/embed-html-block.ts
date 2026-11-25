import { effect, signal, untracked } from "@preact/signals-core";
import {
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorHtmlEmbedControls,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import type { BlockStyleMap } from "@virgultum/content/caption";
import type { EmbedHtmlModel, EmbedHtmlStyles } from "@virgultum/core/models";
import { BlockSelection } from "@virgultum/core/runtime";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import type { EmbedHtmlFullscreenToolbar } from "./components/fullscreen-toolbar.js";
import { HtmlIcon, styles } from "./styles.js";

export class EmbedHtmlBlockComponent extends EmbedBlockComponent<EmbedHtmlModel> {
  protected override blockStyles = styles;

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  protected readonly embedHtmlStyle$ = signal<BlockStyleMap>({});
  iframeWrapper!: HTMLDivElement;

  constructor() {
    super();
    this._cardStyle$.value = "html";
  }

  override get _cardStyle(): (typeof EmbedHtmlStyles)[number] {
    return super._cardStyle as (typeof EmbedHtmlStyles)[number];
  }
  override set _cardStyle(value: (typeof EmbedHtmlStyles)[number]) {
    super._cardStyle = value;
  }

  protected get embedHtmlStyle(): BlockStyleMap {
    return this.embedHtmlStyle$.value;
  }
  protected set embedHtmlStyle(value: BlockStyleMap) {
    this.embedHtmlStyle$.value = value;
  }

  close = () => {
    document.exitFullscreen().catch(console.error);
  };

  open = () => {
    this.iframeWrapper?.requestFullscreen().catch(console.error);
  };

  refreshData = () => {};

  private readonly _handleDoubleClick = (event: MouseEvent) => {
    event.stopPropagation();
    this.open();
  };

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  protected _handleClick(event: MouseEvent) {
    event.stopPropagation();
    this._selectBlock();
  }

  protected override mountEmbedContent(container: HTMLElement) {
    this._cardStyle = this.model.props.style;
    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "style") {
          this._cardStyle = this.model.props.style;
        }
      }),
    );

    const doc = this.ownerDocument;

    const emptyEl = doc.createElement("div");
    emptyEl.className = "myoxus-html-empty";

    const blockEl = doc.createElement("div");
    blockEl.className = "myoxus-embed-html-block";
    this.disposables.addFromEvent(blockEl, "click", (e: MouseEvent) =>
      this._handleClick(e),
    );
    this.disposables.addFromEvent(blockEl, "dblclick", this._handleDoubleClick);

    const htmlWrap = doc.createElement("div");
    htmlWrap.className = "myoxus-embed-html";

    const iframeContainer = doc.createElement("div");
    iframeContainer.className = "myoxus-embed-html-iframe-container";

    const iframeWrapper = doc.createElement("div");
    iframeWrapper.className = "embed-html-block-iframe-wrapper";
    iframeWrapper.setAttribute("allowfullscreen", "");
    this.iframeWrapper = iframeWrapper;

    const iframe = doc.createElement("iframe");
    iframe.className = "embed-html-block-iframe";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.loading = "lazy";

    const toolbar = doc.createElement(
      "embed-html-fullscreen-toolbar",
    ) as EmbedHtmlFullscreenToolbar;
    toolbar.embedHtml = this;

    iframeWrapper.append(iframe, toolbar);

    const overlay = doc.createElement("div");
    overlay.className = "myoxus-embed-html-iframe-overlay";

    iframeContainer.append(iframeWrapper, overlay);
    htmlWrap.append(iframeContainer);

    const titleEl = doc.createElement("div");
    titleEl.className = "myoxus-embed-html-title";

    const iconEl = doc.createElement("div");
    iconEl.className = "myoxus-embed-html-title-icon";
    const iconTpl = doc.createElement("template");
    iconTpl.innerHTML = HtmlIcon;
    if (iconTpl.content.firstElementChild) {
      iconEl.append(iconTpl.content.firstElementChild);
    }

    const titleTextEl = doc.createElement("div");
    titleTextEl.className = "myoxus-embed-html-title-text";

    titleEl.append(iconEl, titleTextEl);
    blockEl.append(htmlWrap, titleEl);

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    const chromeState$ = signal<EditorHtmlEmbedControls | null>(null);
    let chromeUnmount: (() => void) | undefined;
    let chromeMounted = false;
    const mountFrame = (host: HTMLElement) => {
      host.replaceChildren(iframeWrapper, overlay);
      return () => {
        iframeWrapper.remove();
        overlay.remove();
      };
    };

    let lastHtmlSrc: string | null = null;
    let appliedKeys: string[] = [];

    this.disposables.add(() => {
      chromeUnmount?.();
      chromeUnmount = undefined;
    });

    this.disposables.add(
      effect(() => {
        void this.revision$.value;
        const htmlContent = this.model.props.html;
        const selected = this.selected$.value;
        const showOverlay = this.showOverlay$.value;
        const customStyle = this.embedHtmlStyle$.value;
        const emptyLabel = this._text(
          editorMessage("com.myoxus.editor.embed.empty", "Empty"),
        );
        const titleLabel = this._text(
          editorMessage(
            "com.myoxus.editor.embed.html-title",
            "Basic HTML Page Structure",
          ),
        );

        untracked(() => {
          if (htmlContent) {
            const htmlSrc = `
      <style>
        body {
          margin: 0;
        }
      </style>
      ${htmlContent}
    `;
            if (lastHtmlSrc !== htmlSrc) {
              lastHtmlSrc = htmlSrc;
              iframe.srcdoc = htmlSrc;
            }
          }

          overlay.classList.toggle("hide", !showOverlay);

          if (chrome?.mountHtmlEmbed) {
            chromeState$.value = {
              empty: !htmlContent,
              emptyLabel,
              title: titleLabel,
              selected,
              select: (event: MouseEvent) => this._handleClick(event),
              open: this._handleDoubleClick,
              mountFrame,
            };
            if (!chromeMounted) {
              chromeMounted = true;
              const host = doc.createElement("div");
              host.style.width = "100%";
              host.style.height = "100%";
              container.replaceChildren(host);
              chromeUnmount = chrome.mountHtmlEmbed(host, chromeState$);
            }
            return;
          }

          if (!htmlContent) {
            emptyEl.textContent = emptyLabel;
            if (emptyEl.parentNode !== container) {
              container.replaceChildren(emptyEl);
            }
            return;
          }

          if (blockEl.parentNode !== container) {
            container.replaceChildren(blockEl);
          }

          blockEl.classList.toggle("selected", selected);
          titleTextEl.textContent = titleLabel;

          for (const key of appliedKeys) {
            if (customStyle[key] === undefined) {
              blockEl.style.setProperty(
                key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
                "",
              );
            }
          }
          appliedKeys = [];
          for (const [key, value] of Object.entries(customStyle)) {
            if (value !== undefined) {
              (blockEl.style as unknown as Record<string, string>)[key] = value;
              appliedKeys.push(key);
            }
          }
        });
      }),
    );
  }
}
