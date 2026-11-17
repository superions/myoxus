import { LayoutTemplateIcon } from "@myoxus/icons/lit";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import { WithDisposable, SignalWatcher } from "@virgultum/core/primitives/lit";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { requestConnectedFrame, stopPropagation } from "@virgultum/core/utils";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { EdgelessDraggableElementController } from "../../../widgets/edgeless-toolbar/index";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
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

  override createRenderRoot() {
    return this;
  }

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

  private _updateSearchKeyword(value: string) {
    this._searchKeyword = value;
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

  private _preview(template: Template) {
    return template.preview
      ? template.preview.startsWith("<svg")
        ? html`${unsafeSVG(template.preview)}`
        : html`<img src=${template.preview} loading="lazy" />`
      : LayoutTemplateIcon();
  }

  override render() {
    const dragging = this.draggableController?.states.draggingElement;
    return html` <style>
        /* Floating anchoring and SVG/image fitting retain renderer ownership. */
        edgeless-templates-panel {
          position: absolute;
          z-index: 1;
        }
        edgeless-templates-panel .canvas-template-preview svg,
        edgeless-templates-panel .canvas-template-preview img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        edgeless-templates-panel .arrow {
          bottom: 0;
          position: absolute;
          transform: translateY(20px);
          color: var(--myoxus-background-overlay-panel-color);
        }
      </style>
      <div
        style=${styleMap({ opacity: this.isDragging ? "0" : "1", transition: "opacity 0.2s" })}
      >
        ${this.edgeless.std
          .get(EditorChromeHostIdentifier)
          .renderCanvasTemplates({
            query: this._searchKeyword,
            categories: this._categories,
            category: this._currentCategory,
            loading: this._loading,
            readonly: this.edgeless.store.readonly,
            search: (value) => this._updateSearchKeyword(value),
            chooseCategory: (category) => {
              this._currentCategory = category;
              this._updateTemplates();
            },
            items: this._templates.map((template, index) => {
              const preview = this._preview(template);
              return {
                id: template.name ?? String(index),
                label:
                  template.name ??
                  this._text(editorMessage("Template", "Template")),
                preview,
                loading: template === this._loadingTemplate,
                dragging: dragging?.data === template,
                mouseDown: (element, event) =>
                  this.draggableController.onMouseDown(
                    event,
                    { data: template, preview },
                    element,
                  ),
                touchStart: (element, event) =>
                  this.draggableController.onTouchStart(
                    event,
                    { data: template, preview },
                    element,
                  ),
                activate: () => {
                  const { x, y } = this.gfx.viewport.center;
                  this._insertTemplate(template, new Bound(x, y, 0, 0)).catch(
                    console.error,
                  );
                },
              };
            }),
          })}
        <div class="arrow">
          <svg width="24" height="18" viewBox="0 0 24 18" aria-hidden="true">
            <path d="M0 0H24L12 18Z" fill="currentColor" />
          </svg>
        </div>
      </div>`;
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
