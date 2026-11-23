import {
  CanvasElementType,
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
  getSurfaceComponent,
  isNoteBlock,
  Overlay,
  OverlayIdentifier,
  type RoughCanvas,
} from "@virgultum/canvas-runtime/surface";
import {
  type ConnectionOverlay,
  ConnectorPathGenerator,
} from "../../gfx/connector/index";
import { mountShapeTextEditor } from "../../gfx/shape/index";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { type Bound, type IVec, Vec } from "@virgultum/core/primitives/gfx";
import {
  type Connection,
  type ConnectorElementModel,
  DEFAULT_NOTE_HEIGHT,
  DefaultTheme,
  type NoteBlockModel,
  ShapeElementModel,
  shapeMethods,
  type ShapeType,
} from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  ToolbarRegistryIdentifier,
} from "@virgultum/core/services";
import type { SelectedRect } from "@virgultum/core/types";
import { handleNativeRangeAtPoint } from "@virgultum/core/utils";
import type { BlockComponent } from "@virgultum/core/runtime";
import { NativeCanvasWidget } from "../native-canvas-widget";
import {
  GfxControllerIdentifier,
  GfxElementModelView,
} from "@virgultum/core/runtime/gfx";
import { nothing, render, type TemplateResult } from "lit";

import { EdgelessAutoCompletePanel } from "./auto-complete-panel.js";
import {
  createEdgelessElement,
  Direction,
  getPosition,
  isShape,
  MAIN_GAP,
  nextBound,
} from "./utils.js";

class AutoCompleteOverlay extends Overlay {
  linePoints: IVec[] = [];

  renderShape: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  stroke = "";

  override render(ctx: CanvasRenderingContext2D, _rc: RoughCanvas) {
    if (this.linePoints.length && this.renderShape) {
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = this.stroke;
      ctx.beginPath();
      this.linePoints.forEach((p, index) => {
        if (index === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      });
      ctx.stroke();

      this.renderShape(ctx);
      ctx.stroke();
    }
  }
}

type AutoCompleteControl = {
  key: string;
  family: boolean;
  style: Partial<CSSStyleDeclaration>;
  control: TemplateResult | typeof nothing;
};

export class EdgelessAutoComplete extends NativeCanvasWidget {
  private readonly chrome = this.ownerDocument.createElement("div");
  private readonly container = this.ownerDocument.createElement("div");
  private readonly controls = new Map<string, HTMLDivElement>();
  private _isHover = true;
  private _isMoving = false;

  protected override findBlock() {
    return this.edgeless;
  }

  private updateMoving(value: boolean) {
    if (this._isMoving === value) return;
    this._isMoving = value;
    this.requestUpdate();
  }

  private get _surface() {
    return getSurfaceBlock(this.std.store);
  }

  private _pointerDisposables: DisposableGroup | null = null;

  private _active(id = this.current.id) {
    return (
      this.isConnected &&
      !this.std.store.readonly &&
      this.current.id === id &&
      this.crud.getElementById(id) === this.current
    );
  }

  private _autoCompleteOverlay!: AutoCompleteOverlay;

  private readonly _onPointerDown = (e: PointerEvent, type: Direction) => {
    if (!this._active()) return;
    this._pointerDisposables?.dispose();
    this._pointerDisposables = new DisposableGroup();
    const sourceId = this.current.id;
    const viewportRect = this.gfx.viewport.boundingClientRect;
    const start = this.gfx.viewport.toModelCoord(
      e.clientX - viewportRect.left,
      e.clientY - viewportRect.top,
    );

    if (!this.edgeless.std.event) return;

    const eventPointerId = e.pointerId;
    let connector: ConnectorElementModel | null = null;

    this._pointerDisposables.addFromEvent(document, "pointermove", (e) => {
      if (e.pointerId !== eventPointerId || !this._active(sourceId)) return;
      const point = this.gfx.viewport.toModelCoord(
        e.clientX - viewportRect.left,
        e.clientY - viewportRect.top,
      );
      if (Vec.dist(start, point) > 8 && !this._isMoving) {
        if (!this.canShowAutoComplete) return;
        this.updateMoving(true);
        const { startPosition } = getPosition(type);
        connector = this._addConnector(
          {
            id: this.current.id,
            position: startPosition,
          },
          {
            position: point,
          },
        );
      }
      if (this._isMoving) {
        if (!connector) {
          return;
        }
        const otherSideId = connector.source.id;

        connector.target = this.connectionOverlay.renderConnector(
          point,
          otherSideId ? [otherSideId] : [],
        );

        this.std.get(ToolbarRegistryIdentifier).flags.hide();
      }
    });

    this._pointerDisposables.addFromEvent(document, "pointerup", (e) => {
      if (e.pointerId !== eventPointerId) return;
      if (!this._active(sourceId)) {
        this._finishPointer();
        return;
      }
      if (!this._isMoving) {
        this._generateElementOnClick(type);
      } else if (connector && !connector.target.id) {
        this.gfx.selection.clear();
        this._createAutoCompletePanel(e, connector);
      }

      this._finishPointer();
    });
    this._pointerDisposables.addFromEvent(document, "pointercancel", () =>
      this._finishPointer(),
    );
  };

  private _finishPointer() {
    if (!this._pointerDisposables) return;
    this._pointerDisposables.dispose();
    this._pointerDisposables = null;
    this.updateMoving(false);
    this.connectionOverlay.clear();
    this.std.get(ToolbarRegistryIdentifier).flags.show();
  }

  private _pathGenerator!: ConnectorPathGenerator;

  private _timer: ReturnType<typeof setTimeout> | null = null;

  get canShowAutoComplete() {
    const { current } = this;
    return isShape(current) || isNoteBlock(current);
  }

  get connectionOverlay() {
    return this.std.get(OverlayIdentifier("connection")) as ConnectionOverlay;
  }

  get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  private _addConnector(source: Connection, target: Connection) {
    const id = this.crud.addElement(CanvasElementType.CONNECTOR, {
      source,
      target,
      // Match the source stroke already shown by the connection preview.
      ...(isShape(this.current) ? { stroke: this.current.strokeColor } : {}),
    });
    if (!id) return null;
    return this.crud.getElementById(id) as ConnectorElementModel;
  }

  private _computeLine(
    type: Direction,
    curShape: ShapeElementModel,
    nextBound: Bound,
  ) {
    const startBound = this.current.elementBound;
    const { startPosition, endPosition } = getPosition(type);
    const nextShape = {
      xywh: nextBound.serialize(),
      rotate: curShape.rotate,
      shapeType: curShape.shapeType,
    };
    const startPoint = curShape.getRelativePointLocation(startPosition);
    const endPoint = curShape.getRelativePointLocation.call(
      nextShape,
      endPosition,
    );

    return this._pathGenerator.generateOrthogonalConnectorPath({
      startBound,
      endBound: nextBound,
      startPoint,
      endPoint,
    });
  }

  private _computeNextBound(type: Direction) {
    if (isShape(this.current)) {
      const connectedShapes = this._getConnectedElements(this.current).filter(
        (e) => e instanceof ShapeElementModel,
      ) as ShapeElementModel[];
      return nextBound(type, this.current, connectedShapes);
    } else {
      const bound = this.current.elementBound;
      switch (type) {
        case Direction.Right: {
          bound.x += bound.w + MAIN_GAP;
          break;
        }
        case Direction.Bottom: {
          bound.y += bound.h + MAIN_GAP;
          break;
        }
        case Direction.Left: {
          bound.x -= bound.w + MAIN_GAP;
          break;
        }
        case Direction.Top: {
          bound.y -= bound.h + MAIN_GAP;
          break;
        }
      }
      return bound;
    }
  }

  private _createAutoCompletePanel(
    e: PointerEvent,
    connector: ConnectorElementModel,
  ) {
    if (!this.canShowAutoComplete) return;

    const rect = this.gfx.viewport.boundingClientRect;
    const position = this.gfx.viewport.toModelCoord(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const autoCompletePanel = new EdgelessAutoCompletePanel(
      position,
      this.edgeless,
      this.current,
      connector,
    );

    this.edgeless.append(autoCompletePanel);
  }

  private _generateElementOnClick(type: Direction) {
    if (!this._active()) return;
    const { store } = this.edgeless;
    const bound = this._computeNextBound(type);
    const id = createEdgelessElement(this.edgeless, this.current, bound);
    if (!id) return;
    if (isShape(this.current)) {
      const { startPosition, endPosition } = getPosition(type);
      this._addConnector(
        {
          id: this.current.id,
          position: startPosition,
        },
        {
          id,
          position: endPosition,
        },
      );

      mountShapeTextEditor(
        this.crud.getElementById(id) as ShapeElementModel,
        this.edgeless,
      );
    } else {
      const model = store.getModelById(id);
      if (!model) {
        return;
      }
      const [x, y] = this.gfx.viewport.toViewCoord(
        bound.center[0],
        bound.y + DEFAULT_NOTE_HEIGHT / 2,
      );
      // Keep focus across native trigger replacement before the queued inline caret placement.
      this.edgeless.host.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        handleNativeRangeAtPoint(x, y);
      });
    }

    this.gfx.selection.set({
      elements: [id],
      editing: true,
    });
    this.removeOverlay();
  }

  private _getConnectedElements(element: ShapeElementModel) {
    if (!this._surface) return [];

    return this._surface.getConnectors(element.id).reduce((prev, current) => {
      if (current.target.id === element.id && current.source.id) {
        prev.push(
          this.crud.getElementById(current.source.id) as ShapeElementModel,
        );
      }
      if (current.source.id === element.id && current.target.id) {
        prev.push(
          this.crud.getElementById(current.target.id) as ShapeElementModel,
        );
      }

      return prev;
    }, [] as ShapeElementModel[]);
  }

  private _initOverlay() {
    const surface = getSurfaceComponent(this.std);
    if (!surface) return;
    this._autoCompleteOverlay = new AutoCompleteOverlay(this.gfx);
    surface.renderer.addOverlay(this._autoCompleteOverlay);
  }

  private _renderArrows() {
    const isShape = this.current instanceof ShapeElementModel;
    const { selectedRect } = this;
    const { zoom } = this.gfx.viewport;
    const width = 72;
    const height = 44;

    // Auto-complete arrows for shape and note are different
    // Shape: right, bottom, left, top
    // Note: right, left
    const arrowDirections = isShape
      ? [Direction.Right, Direction.Bottom, Direction.Left, Direction.Top]
      : [Direction.Right, Direction.Left];
    const arrowMargin = isShape ? height / 2 : height * (2 / 3);
    return arrowDirections.map<AutoCompleteControl>((type) => {
      const { startPosition } = getPosition(type);
      const [horizontal, vertical] = startPosition;
      // Project the same directional ports into selection coordinates, extending by the original hit margin.
      const x =
        selectedRect.width * horizontal + (horizontal - 0.5) * 2 * arrowMargin;
      const y =
        selectedRect.height * vertical + (vertical - 0.5) * 2 * arrowMargin;
      const transform = `translate(${x}px, ${y}px)${isShape ? `rotate(${(type + 1) * 90}deg)` : ""} translate(${-width / 2}px, ${-height / 2}px)`;
      return {
        key: String(type),
        family: false,
        style: {
          position: "absolute",
          width: `${width}px`,
          height: `${height}px`,
          display:
            !isShape && type === Direction.Left && zoom >= 1.5
              ? "none"
              : "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "auto",
          transform,
          transformOrigin: "left top",
        },
        control: this._renderTrigger(type),
      };
    });
  }

  private _renderTrigger(type: Direction) {
    const sourceId = this.current.id;
    const label = {
      [Direction.Right]: editorMessage(
        "com.myoxus.editor.canvas.add-same-object-right",
        "Add another object of this type to the right",
      ),
      [Direction.Bottom]: editorMessage(
        "com.myoxus.editor.canvas.add-same-object-below",
        "Add another object of this type below",
      ),
      [Direction.Left]: editorMessage(
        "com.myoxus.editor.canvas.add-same-object-left",
        "Add another object of this type to the left",
      ),
      [Direction.Top]: editorMessage(
        "com.myoxus.editor.canvas.add-same-object-above",
        "Add another object of this type above",
      ),
    }[type];
    return (
      this.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderAutoCompleteTrigger({
          label: resolveEditorMessage(
            label,
            this.std.getOptional(EditorI18nProvider) ?? undefined,
          ),
          icon: isShape(this.current) ? "ArrowUpBigIcon" : "PlusIcon",
          preview: (active) => {
            this.removeOverlay();
            if (active && this._active(sourceId) && isShape(this.current)) {
              this._timer = setTimeout(() => {
                if (!this._active(sourceId) || !isShape(this.current)) return;
                const bound = this._computeNextBound(type);
                this._showNextShape(
                  this.current,
                  bound,
                  this._computeLine(type, this.current, bound),
                  this.current.shapeType,
                );
              }, 300);
            }
          },
          pointerDown: (event) => {
            if (this._active(sourceId)) this._onPointerDown(event, type);
          },
          activate: () => {
            if (this._active(sourceId)) this._generateElementOnClick(type);
          },
        }) ?? nothing
    );
  }

  private _showNextShape(
    current: ShapeElementModel,
    bound: Bound,
    path: IVec[],
    targetType: ShapeType,
  ) {
    const surface = getSurfaceComponent(this.std);
    if (!surface) return;

    this._autoCompleteOverlay.stroke = surface.renderer.getColorValue(
      current.strokeColor,
      DefaultTheme.shapeStrokeColor,
      true,
    );
    this._autoCompleteOverlay.linePoints = path;
    this._autoCompleteOverlay.renderShape = (ctx) => {
      shapeMethods[targetType].draw(ctx, { ...bound, rotate: current.rotate });
    };
    surface.refresh();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._pathGenerator = new ConnectorPathGenerator({
      getElementById: (id) => this.crud.getElementById(id),
    });
    this._initOverlay();
    // Selection handles remain in their shadow renderer. Native controls mount beside
    // it in the same editor's light DOM so the shared Mantine stylesheet reaches them.
    this.chrome.dataset.rangeSyncExclude = "true";
    Object.assign(this.chrome.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
      zIndex: "1",
    });
    this.container.className = "edgeless-auto-complete-container";
    this.container.style.position = "absolute";
    this.chrome.append(this.container);
    this.edgeless.append(this.chrome);
    this.disposables.add(
      this.store.readonly$.subscribe(() => this.requestUpdate()),
    );
    this._subscribe();
  }

  private _subscribe() {
    const { disposables, edgeless, gfx } = this;

    [
      gfx.selection.slots.updated.subscribe(() => {
        this.removeOverlay();
        this.requestUpdate();
      }),
      edgeless.host.event.add("pointerMove", (ctx) => {
        const evt = ctx.get("pointerState");
        const [x, y] = gfx.viewport.toModelCoord(evt.x, evt.y);
        const elm = gfx.getElementByPoint(x, y);
        const hovering = elm === this.current;
        if (hovering === this._isHover) return;
        this._isHover = hovering;
        this.requestUpdate();
      }),
      edgeless.host.event.add("dragStart", () => {
        this.updateMoving(true);
      }),
      edgeless.host.event.add("dragEnd", () => {
        this.updateMoving(false);
      }),
    ].forEach((subscription) => disposables.add(subscription));
  }

  private _canAutoComplete() {
    const selection = this.gfx.selection;
    return (
      selection.selectedElements.length === 1 &&
      (selection.selectedElements[0] instanceof ShapeElementModel ||
        isNoteBlock(selection.selectedElements[0]))
    );
  }

  removeOverlay() {
    this._timer && clearTimeout(this._timer);
    const surface = getSurfaceComponent(this.std);
    if (!surface) return;
    // Keep the registered overlay for the mounted controller; only its transient paint is cleared.
    if (this._autoCompleteOverlay) {
      this._autoCompleteOverlay.linePoints = [];
      this._autoCompleteOverlay.renderShape = null;
      surface.refresh();
    }
  }

  override disconnectedCallback() {
    this._finishPointer();
    this.removeOverlay();
    getSurfaceComponent(this.std)?.renderer.removeOverlay(
      this._autoCompleteOverlay,
    );
    this.drawControls([]);
    this.chrome.remove();
    super.disconnectedCallback();
  }

  private drawControls(entries: readonly AutoCompleteControl[]) {
    const stale = new Set(this.controls.keys());
    for (const { key, family, style, control } of entries) {
      let anchor = this.controls.get(key);
      if (!anchor) {
        anchor = this.ownerDocument.createElement("div");
        anchor.className = family
          ? "edgeless-auto-complete-arrow-wrapper family"
          : "edgeless-auto-complete-arrow-wrapper";
        this.controls.set(key, anchor);
        this.container.append(anchor);
      }
      Object.assign(anchor.style, style);
      render(control, anchor);
      stale.delete(key);
    }
    for (const key of stale) {
      const anchor = this.controls.get(key)!;
      render(nothing, anchor);
      anchor.remove();
      this.controls.delete(key);
    }
  }

  protected paint() {
    if (!this._active()) {
      this.drawControls([]);
      return;
    }
    const isShape = this.current instanceof ShapeElementModel;
    const sourceId = this.current.id;
    const owner = this.current.group;
    const view = owner && this.gfx.view.get(owner);
    const actions =
      view instanceof GfxElementModelView
        ? view.getSelectionActions(
            this.current,
            this.selectedRect,
            this.gfx.viewport.zoom,
          )
        : null;

    if (
      // Source-owned membership must only change through the owner's commands.
      (owner &&
        "managesChildMembership" in owner &&
        owner.managesChildMembership &&
        !actions) ||
      this._isMoving ||
      (this._isHover && !isShape && !this._canAutoComplete())
    ) {
      this.removeOverlay();
      this.drawControls([]);
      return;
    }
    const { selectedRect } = this;

    Object.assign(this.container.style, {
      top: selectedRect.top + "px",
      left: selectedRect.left + "px",
      width: selectedRect.width + "px",
      height: selectedRect.height + "px",
      transform: `rotate(${selectedRect.rotate}deg)`,
    });
    this.drawControls(
      actions
        ? actions.map((action) => ({
            key: `family:${action.id}`,
            family: true,
            style: {
              position: "absolute",
              width: "26px",
              height: "26px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "auto",
              transform: `translate(${action.left}px, ${action.top}px)${action.mirrored ? " scale(-1)" : ""} translate(-13px, -13px)`,
            },
            control:
              this.std
                .getOptional(EditorChromeHostIdentifier)
                ?.renderAutoCompleteTrigger({
                  label: action.id,
                  artwork: action.icon,
                  preview: () => {},
                  pointerDown: () => {
                    if (this._active(sourceId)) action.run();
                  },
                  activate: () => {
                    if (this._active(sourceId)) action.run();
                  },
                }) ?? nothing,
          }))
        : this._renderArrows(),
    );
  }

  current!: ShapeElementModel | NoteBlockModel;
  edgeless!: BlockComponent;
  selectedRect!: SelectedRect;
}
