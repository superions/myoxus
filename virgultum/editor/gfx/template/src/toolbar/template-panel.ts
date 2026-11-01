import { LayoutTemplateIcon } from "@myoxus/icons/lit";
import { baseTheme } from "@myoxus/theme";
import { DefaultTool } from "@virgultum/block-surface";
import {
  darkToolbarStyles,
  lightToolbarStyles,
} from "@virgultum/components/toolbar";
import type { Bound } from "@virgultum/global/gfx";
import { WithDisposable, SignalWatcher } from "@virgultum/global/lit";
import {
  EditPropsStore,
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import {
  requestConnectedFrame,
  stopPropagation,
} from "@virgultum/shared/utils";
import type { BlockComponent } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { EdgelessDraggableElementController } from "@virgultum/widget-edgeless-toolbar";
import { css, html, LitElement, nothing, unsafeCSS } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";

import { createTemplateJob } from "../services/template.js";
import { builtInTemplates } from "./builtin-templates.js";
import type { Template } from "./template-type.js";
import { cloneDeep } from "./utils.js";

export class EdgelessTemplatePanel extends SignalWatcher(
  WithDisposable(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    :host {
      position: absolute;
      font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
      z-index: 1;
    }

    .edgeless-templates-panel {
      width: 467px;
      height: 568px;
      border-radius: 12px;
      background-color: var(--myoxus-background-overlay-panel-color);
      box-shadow: 0px 10px 80px 0px rgba(0, 0, 0, 0.2);

      display: flex;
      flex-direction: column;
    }
    ${unsafeCSS(lightToolbarStyles(".edgeless-templates-panel"))}
    ${unsafeCSS(darkToolbarStyles(".edgeless-templates-panel"))}

    .search-bar {
      padding: 21px 24px;
      font-size: 18px;
      color: var(--myoxus-secondary);
      border-bottom: 1px solid var(--myoxus-divider-color);

      flex-shrink: 0;
    }

    .search-input {
      border: 0;
      color: var(--myoxus-text-primary-color);
      font-size: 20px;
      background-color: inherit;
      outline: none;
      width: 100%;
    }

    .search-input::placeholder {
      color: var(--myoxus-text-secondary-color);
    }

    .template-categories {
      display: flex;
      padding: 6px 8px;
      gap: 4px;
      overflow-x: scroll;

      flex-shrink: 0;
    }

    .category-entry {
      color: var(--myoxus-text-primary-color);
      font-size: 12px;
      font-weight: 600;
      line-height: 20px;
      border-radius: 8px;
      flex-shrink: 0;
      flex-grow: 0;
      width: fit-content;
      padding: 4px 9px;
      cursor: pointer;
    }

    .category-entry.selected,
    .category-entry:hover {
      color: var(--myoxus-text-primary-color);
      background-color: var(--myoxus-background-tertiary-color);
    }

    .template-viewport {
      position: relative;
      flex-grow: 1;
    }

    .template-scrollcontent {
      overflow: hidden;
      height: 100%;
      width: 100%;
    }

    .template-list {
      padding: 10px;
      display: flex;
      align-items: flex-start;
      align-content: flex-start;
      gap: 10px 20px;
      flex-wrap: wrap;
    }

    .template-item {
      position: relative;
      width: 135px;
      height: 80px;
      box-shadow: 0px 4px 4px 0px rgba(0, 0, 0, 0.02);
      background-color: var(--myoxus-background-primary-color);
      border-radius: 4px;
      cursor: pointer;
    }

    .template-item > svg {
      display: block;
      margin: 0 auto;
      width: 135px;
      height: 80px;
      color: var(--myoxus-icon-color);
    }

    /* .template-item:hover::before {
      content: attr(data-hover-text);
      position: absolute;
      display: block;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 110px;
      border-radius: 8px;
      padding: 4px 22px;
      box-sizing: border-box;
      z-index: 1;
      text-align: center;
      font-size: 12px;

      background-color: var(--myoxus-primary-color);
      color: var(--myoxus-white);
    } */

    .template-item:hover::after {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      border: 1px solid var(--myoxus-black-10);
      border-radius: 4px;
      background-color: var(--myoxus-hover-color);
    }

    .template-item.loading::before {
      display: none;
    }

    .template-item.loading > myoxus-template-loading {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }

    .template-item img.template-preview {
      object-fit: contain;
      width: 100%;
      height: 100%;
      display: block;
    }

    .arrow {
      bottom: 0;
      position: absolute;
      transform: translateY(20px);
      color: var(--myoxus-background-overlay-panel-color);
    }
  `;

  static templates = builtInTemplates;

  private _fetchJob: null | { cancel: () => void } = null;

  draggableController!: EdgelessDraggableElementController<Template>;

  private _closePanel() {
    if (this.isDragging) return;
    this.dispatchEvent(new CustomEvent("closepanel"));
  }

  private _fetch(fn: (state: { canceled: boolean }) => Promise<unknown>) {
    if (this._fetchJob) {
      this._fetchJob.cancel();
    }

    this._loading = true;

    const state = { canceled: false };
    const job = {
      cancel: () => {
        state.canceled = true;
      },
    };

    this._fetchJob = job;

    fn(state)
      .catch((e) => console.warn("[template-panel] fetch failed", e))
      .finally(() => {
        if (!state.canceled && job === this._fetchJob) {
          this._loading = false;
          this._fetchJob = null;
        }
      });
  }

  private _getLocalSelectedCategory() {
    return this.edgeless.std.get(EditPropsStore).getStorage("templateCache");
  }

  private async _initCategory() {
    try {
      this._categories = await EdgelessTemplatePanel.templates.categories();
      this._currentCategory =
        this._getLocalSelectedCategory() ?? this._categories[0];
      this._updateTemplates();
    } catch (e) {
      console.error("Failed to load categories", e);
    }
  }

  private _initDragController() {
    if (this.draggableController) return;
    this.draggableController = new EdgelessDraggableElementController(this, {
      edgeless: this.edgeless,
      clickToDrag: true,
      standardWidth: 560,
      onOverlayCreated: (overlay) => {
        this.isDragging = true;
        overlay.mask.style.color = "transparent";
      },
      onDrop: (el, bound) => {
        this._insertTemplate(el.data, bound)
          .finally(() => {
            this.isDragging = false;
          })
          .catch(console.error);
      },
      onCanceled: () => {
        this.isDragging = false;
      },
    });
  }

  get gfx() {
    return this.edgeless.std.get(GfxControllerIdentifier);
  }

  private async _insertTemplate(template: Template, bound: Bound) {
    this._loadingTemplate = template;

    template = cloneDeep(template);

    const center = {
      x: bound.x + bound.w / 2,
      y: bound.y + bound.h / 2,
    };
    const templateJob = createTemplateJob(
      this.edgeless.std,
      template.type,
      center,
    );

    try {
      const { assets } = template;

      if (assets) {
        await Promise.all(
          Object.entries(assets).map(([key, value]) =>
            fetch(value)
              .then((res) => res.blob())
              .then((blob) => templateJob.job.assets.set(key, blob)),
          ),
        );
      }

      const insertedBound = await templateJob.insertTemplate(template.content);

      if (insertedBound && template.type === "template") {
        const padding = 20 / this.gfx.viewport.zoom;
        this.gfx.viewport.setViewportByBound(
          insertedBound,
          [padding, padding, padding, padding],
          true,
        );
      }
    } finally {
      this._loadingTemplate = null;
      this.gfx.tool.setTool(DefaultTool);
    }
  }

  private _updateSearchKeyword(inputEvt: InputEvent) {
    this._searchKeyword = (inputEvt.target as HTMLInputElement).value;
    this._updateTemplates();
  }

  private _updateTemplates() {
    this._fetch(async (state) => {
      try {
        const templates = this._searchKeyword
          ? await EdgelessTemplatePanel.templates.search(this._searchKeyword)
          : await EdgelessTemplatePanel.templates.list(this._currentCategory);

        if (state.canceled) return;

        this._templates = templates;
      } catch (e) {
        if (state.canceled) return;

        console.error("Failed to load templates", e);
      }
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._initDragController();

    this.addEventListener("keydown", stopPropagation, false);
    this._disposables.add(() => {
      if (this._currentCategory) {
        this.edgeless.std
          .get(EditPropsStore)
          .setStorage("templateCache", this._currentCategory);
      }
    });
  }

  override firstUpdated() {
    requestConnectedFrame(() => {
      this._disposables.addFromEvent(document, "click", (evt) => {
        if (this.contains(evt.target as HTMLElement)) {
          return;
        }

        this._closePanel();
      });
    }, this);
    this._disposables.addFromEvent(this, "click", stopPropagation);
    this._disposables.addFromEvent(this, "wheel", stopPropagation);

    this._initCategory().catch((e) =>
      console.warn("[template-panel] init failed", e),
    );
  }

  override render() {
    const { _categories, _currentCategory, _templates } = this;
    const { draggingElement } = this.draggableController?.states || {};
    const appTheme = this.edgeless.std.get(ThemeProvider).app$.value;

    return html`
      <div
        class="edgeless-templates-panel"
        data-app-theme=${appTheme}
        style=${styleMap({
          opacity: this.isDragging ? "0" : "1",
          transition: "opacity 0.2s",
        })}
      >
        <div class="search-bar">
          <input
            class="search-input"
            type="text"
            placeholder=${this._text(editorMessage("com.myoxus.editor.template.search", "Search templates"))}
            @input=${this._updateSearchKeyword}
            @cut=${stopPropagation}
            @copy=${stopPropagation}
            @paste=${stopPropagation}
          />
        </div>
        <div class="template-categories">
          ${repeat(
            _categories,
            (cate) => cate,
            (cate) => {
              return html`<div
                class="category-entry ${
                  _currentCategory === cate ? "selected" : ""
                }"
                @click=${() => {
                  this._currentCategory = cate;
                  this._updateTemplates();
                }}
              >
                ${cate}
              </div>`;
            },
          )}
        </div>
        <div class="template-viewport">
          <div class="template-scrollcontent" data-scrollable>
            <div class="template-list">
              ${
                this._loading
                  ? html`<myoxus-template-loading
                      style=${styleMap({
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                      })}
                    ></myoxus-template-loading>`
                  : repeat(
                      _templates,
                      (template) => template.name,
                      (template) => {
                        const preview = template.preview
                          ? template.preview.startsWith("<svg")
                            ? html`${unsafeSVG(template.preview)}`
                            : html`<img
                                src="${template.preview}"
                                class="template-preview"
                                loading="lazy"
                              />`
                          : LayoutTemplateIcon();

                        const isBeingDragged =
                          draggingElement &&
                          draggingElement.data.name === template.name;
                        return html`
                          <div
                            class=${`template-item ${
                              template === this._loadingTemplate
                                ? "loading"
                                : ""
                            }`}
                            style=${styleMap({
                              opacity: isBeingDragged ? "0" : "1",
                            })}
                            data-hover-text="Add"
                            @mousedown=${(e: MouseEvent) =>
                              this.draggableController.onMouseDown(e, {
                                data: template,
                                preview,
                              })}
                            @touchstart=${(e: TouchEvent) => {
                              this.draggableController.onTouchStart(e, {
                                data: template,
                                preview,
                              });
                            }}
                          >
                            ${preview}
                            ${
                              template === this._loadingTemplate
                                ? html`<myoxus-template-loading></myoxus-template-loading>`
                                : nothing
                            }
                            ${
                              template.name
                                ? html`<myoxus-tooltip
                                    .offset=${12}
                                    .autoHide=${true}
                                    tip-position="top"
                                  >
                                    ${template.name}
                                  </myoxus-tooltip>`
                                : nothing
                            }
                          </div>
                        `;
                      },
                    )
              }
            </div>
          </div>
          <overlay-scrollbar></overlay-scrollbar>
        </div>
        <div class="arrow">
          <svg width="24" height="18" viewBox="0 0 24 18" aria-hidden="true">
            <path d="M0 0H24L12 18Z" fill="currentColor" />
          </svg>
        </div>
      </div>
    `;
  }

  @state()
  private accessor _categories: string[] = [];

  @state()
  private accessor _currentCategory = "";

  @state()
  private accessor _loading = false;

  @state()
  private accessor _loadingTemplate: Template | null = null;

  @state()
  private accessor _searchKeyword = "";

  @state()
  private accessor _templates: Template[] = [];

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  @state()
  accessor isDragging = false;
}
