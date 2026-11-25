import { effect, signal, type Signal } from "@preact/signals-core";
import { LayoutTemplateIcon } from "@myoxus/icons/native";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { Bound } from "@virgultum/core/primitives/gfx";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  type EditorCanvasTemplateControls,
  type EditorCanvasTemplatePreview,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { stopPropagation } from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EdgelessDraggableElementController,
  type DraggablePreview,
  type NativeReactiveController,
} from "../../../widgets/edgeless-toolbar/index";

import { createTemplateJob } from "../services/template.js";
import { builtInTemplates } from "./builtin-templates.js";
import type { Template } from "./template-type.js";
import { cloneDeep } from "./utils.js";

const templatePanelStyles = `
  /* SVG/image preview fitting retains renderer ownership; Mantine Popover owns anchoring and arrow. */
  edgeless-templates-panel .canvas-template-preview svg,
  edgeless-templates-panel .canvas-template-preview img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
`;

export class EdgelessTemplatePanel extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _controllers = new Set<NativeReactiveController>();
  private readonly _revision$ = signal(0);
  private _bound = false;
  private _edgeless!: BlockComponent;
  private _categories: string[] = [];
  private _currentCategory = "";
  private _loading = false;
  private _loadingTemplate: Template | null = null;
  private _searchKeyword = "";
  private _templates: Template[] = [];
  private _isDragging = false;
  private _wrapperEl: HTMLDivElement | null = null;
  private _chrome?: {
    host: HTMLSpanElement;
    state$: Signal<EditorCanvasTemplateControls | null>;
    unmount: () => void;
  };

  get disposables() {
    return this._disposables;
  }

  get edgeless() {
    return this._edgeless;
  }

  set edgeless(value: BlockComponent) {
    if (this._edgeless === value) return;
    this._edgeless = value;
    if (this.isConnected) {
      this._ensureBound();
      this.requestUpdate();
    }
  }

  get isDragging() {
    return this._isDragging;
  }

  set isDragging(value: boolean) {
    if (this._isDragging === value) return;
    this._isDragging = value;
    this.requestUpdate();
  }

  addController(controller: NativeReactiveController) {
    this._controllers.add(controller);
    if (this.isConnected && this._bound) {
      controller.hostConnected?.();
    }
  }

  requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
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
    this.requestUpdate();

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
          this.requestUpdate();
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
      this.requestUpdate();
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
    this.requestUpdate();

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
      this.requestUpdate();
      this.gfx.tool.setTool(DefaultTool);
    }
  }

  private _updateSearchKeyword(value: string) {
    this._searchKeyword = value;
    this.requestUpdate();
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
        this.requestUpdate();
      } catch (e) {
        if (state.canceled) return;

        console.error("Failed to load templates", e);
      }
    });
  }

  private _ensureDom() {
    if (this._wrapperEl) return;
    const style = this.ownerDocument.createElement("style");
    style.textContent = templatePanelStyles;
    const wrapper = this.ownerDocument.createElement("div");
    wrapper.style.transition = "opacity 0.2s";
    this.append(style, wrapper);
    this._wrapperEl = wrapper;
  }

  private _ensureBound() {
    if (this._bound || !this.isConnected || !this._edgeless) return;
    this._bound = true;
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    this._ensureDom();
    this._initDragController();
    for (const controller of this._controllers) {
      controller.hostConnected?.();
    }

    this._disposables.addFromEvent(this, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this._closePanel();
        return;
      }
      event.stopPropagation();
    });
    this._disposables.addFromEvent(this, "click", stopPropagation);
    this._disposables.addFromEvent(this, "wheel", stopPropagation);
    this._disposables.add(() => {
      if (this._currentCategory) {
        this.edgeless.std
          .get(EditPropsStore)
          .setStorage("templateCache", this._currentCategory);
      }
    });

    this._initCategory().catch((e) =>
      console.warn("[template-panel] init failed", e),
    );

    this._disposables.add(
      effect(() => {
        void this._revision$.value;
        if (!this.isConnected || !this._edgeless) return;
        this._paint();
      }),
    );
  }

  connectedCallback(): void {
    this._ensureBound();
  }

  disconnectedCallback(): void {
    for (const controller of this._controllers) {
      controller.hostDisconnected?.();
    }
    if (this._chrome) {
      this._chrome.unmount();
      this._chrome.host.remove();
      this._chrome = undefined;
    }
    this._disposables.dispose();
    this._bound = false;
  }

  private _preview(template: Template): EditorCanvasTemplatePreview {
    if (!template.preview) return { kind: "fallback" };
    return template.preview.startsWith("<svg")
      ? { kind: "svg", markup: template.preview }
      : { kind: "image", src: template.preview };
  }

  private _dragPreview(template: Template): DraggablePreview {
    if (!template.preview) return LayoutTemplateIcon;
    if (template.preview.startsWith("<svg")) return template.preview;
    return () => {
      const img = this.ownerDocument.createElement("img");
      img.src = template.preview!;
      img.loading = "lazy";
      return img;
    };
  }

  private _paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome || !this._wrapperEl) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    this._wrapperEl.style.opacity = this.isDragging ? "0" : "1";

    const dragging = this.draggableController?.states.draggingElement;
    const controls: EditorCanvasTemplateControls = {
      query: this._searchKeyword,
      categories: this._categories,
      category: this._currentCategory,
      loading: this._loading,
      readonly: this.edgeless.store.readonly,
      search: (value) => this._updateSearchKeyword(value),
      chooseCategory: (category) => {
        this._currentCategory = category;
        this.requestUpdate();
        this._updateTemplates();
      },
      items: this._templates.map((template, index) => {
        const preview = this._preview(template);
        const dragPreview = this._dragPreview(template);
        return {
          id: template.name ?? String(index),
          label:
            template.name ?? this._text(editorMessage("Template", "Template")),
          preview,
          loading: template === this._loadingTemplate,
          dragging: dragging?.data === template,
          mouseDown: (element, event) =>
            this.draggableController.onMouseDown(
              event,
              { data: template, preview: dragPreview },
              element,
            ),
          touchStart: (element, event) =>
            this.draggableController.onTouchStart(
              event,
              { data: template, preview: dragPreview },
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
    };

    if (!this._chrome) {
      const host = this.ownerDocument.createElement("span");
      host.style.display = "contents";
      this._wrapperEl.insertBefore(host, this._wrapperEl.firstChild);
      const state$ = signal<EditorCanvasTemplateControls | null>(controls);
      const unmount = chrome.mountCanvasTemplates(host, state$);
      this._chrome = { host, state$, unmount };
    } else {
      this._chrome.state$.value = controls;
    }
  }
}
