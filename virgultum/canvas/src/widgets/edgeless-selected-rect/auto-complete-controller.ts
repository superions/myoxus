// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal } from "@preact/signals-core";
import type { MyoxusIconExportName } from "@myoxus/icons/names";
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
  type Connection,
  type ConnectorElementModel,
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
  DefaultTheme,
  getShapeName,
  GroupElementModel,
  NoteBlockModel,
  ShapeElementModel,
  shapeMethods,
  type ShapeType,
} from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  Bound,
  type IVec,
  normalizeDegAngle,
  serializeXYWH,
  toDegree,
  Vec,
  type XYWH,
} from "@virgultum/core/primitives/gfx";
import type { BlockComponent } from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  GfxElementModelView,
} from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  EditPropsStore,
  editorMessage,
  resolveEditorMessage,
  ThemeProvider,
  ToolbarRegistryIdentifier,
  type EditorAutoCompleteControls,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import type { SelectedRect } from "@virgultum/core/types";
import { handleNativeRangeAtPoint, matchModels } from "@virgultum/core/utils";
import * as Y from "yjs";

import { EdgelessFrameManagerIdentifier } from "../../blocks/frame/index";
import {
  type ConnectionOverlay,
  ConnectorPathGenerator,
} from "../../gfx/connector/index";
import {
  mountShapeTextEditor,
  SHAPE_OVERLAY_HEIGHT,
  SHAPE_OVERLAY_WIDTH,
  ShapeComponentConfig,
} from "../../gfx/shape/index";
import { insertEdgelessTextCommand } from "../../gfx/text/index";
import {
  type AUTO_COMPLETE_TARGET_TYPE,
  AutoCompleteFrameOverlay,
  AutoCompleteNoteOverlay,
  AutoCompleteShapeOverlay,
  AutoCompleteTextOverlay,
  createEdgelessElement,
  createShapeElement,
  DEFAULT_NOTE_OVERLAY_HEIGHT,
  DEFAULT_TEXT_HEIGHT,
  DEFAULT_TEXT_WIDTH,
  Direction,
  getPosition,
  isShape,
  MAIN_GAP,
  nextBound,
  type TARGET_SHAPE_TYPE,
} from "./utils.js";

class PreviewLineOverlay extends Overlay {
  linePoints: IVec[] = [];
  renderShape: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  stroke = "";

  override render(ctx: CanvasRenderingContext2D, _rc: RoughCanvas) {
    if (!this.linePoints.length || !this.renderShape) return;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = this.stroke;
    ctx.beginPath();
    this.linePoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.stroke();
    this.renderShape(ctx);
    ctx.stroke();
  }
}

type PanelSession = {
  position: [number, number];
  source: ShapeElementModel | NoteBlockModel;
  connector: ConnectorElementModel;
};

type PanelOverlay =
  | AutoCompleteShapeOverlay
  | AutoCompleteNoteOverlay
  | AutoCompleteFrameOverlay
  | AutoCompleteTextOverlay;

/**
 * Pure-TypeScript AGPL signal controller for Edgeless auto-complete arrows,
 * connector drag-out, and target-type picker panel.
 * Replaces `EdgelessAutoComplete` and `EdgelessAutoCompletePanel`.
 */
export class AutoCompleteController {
  private readonly disposables = new DisposableGroup();
  private readonly state$ = signal<EditorAutoCompleteControls | null>(null);
  private readonly chromeHost: HTMLDivElement;
  private readonly pathGenerator: ConnectorPathGenerator;

  private lineOverlay: PreviewLineOverlay | null = null;
  private panelOverlay: PanelOverlay | null = null;
  private pointerDisposables: DisposableGroup | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  private current: ShapeElementModel | NoteBlockModel | null = null;
  private selectedRect: SelectedRect | null = null;
  private panelSession: PanelSession | null = null;
  private isHover = true;
  private isMoving = false;
  private disposed = false;

  constructor(private readonly edgeless: BlockComponent) {
    this.pathGenerator = new ConnectorPathGenerator({
      getElementById: (id) => this.crud.getElementById(id),
    });

    const doc = edgeless.ownerDocument;
    this.chromeHost = doc.createElement("div");
    this.chromeHost.dataset.rangeSyncExclude = "true";
    Object.assign(this.chromeHost.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
      zIndex: "1",
    });
    edgeless.append(this.chromeHost);

    const surface = getSurfaceComponent(this.std);
    if (surface) {
      this.lineOverlay = new PreviewLineOverlay(this.gfx);
      surface.renderer.addOverlay(this.lineOverlay);
    }

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (chrome?.mountAutoComplete) {
      this.disposables.add(
        chrome.mountAutoComplete(this.chromeHost, this.state$),
      );
    }

    this.disposables.add(this.store.readonly$.subscribe(() => this.sync()));
    this.disposables.add(
      this.gfx.selection.slots.updated.subscribe(() => {
        this.clearLineOverlay();
        this.sync();
      }),
    );
    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        if (this.panelSession) this.sync();
      }),
    );
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => {
        if (this.panelSession) this.sync();
      }),
    );
    const surfaceBlock = this.gfx.surface;
    if (surfaceBlock) {
      this.disposables.add(
        surfaceBlock.elementRemoved.subscribe(() => {
          if (this.panelSession) this.sync();
        }),
      );
    }
    this.disposables.add(
      edgeless.host.event.add("pointerMove", (ctx) => {
        if (!this.current) return;
        const evt = ctx.get("pointerState");
        const [x, y] = this.gfx.viewport.toModelCoord(evt.x, evt.y);
        const hit = this.gfx.getElementByPoint(x, y);
        const hovering = hit === this.current;
        if (hovering !== this.isHover) {
          this.isHover = hovering;
          this.sync();
        }
      }),
    );
    this.disposables.add(
      edgeless.host.event.add("dragStart", () => {
        this.setMoving(true);
      }),
    );
    this.disposables.add(
      edgeless.host.event.add("dragEnd", () => {
        this.setMoving(false);
      }),
    );
  }

  private get std() {
    return this.edgeless.std;
  }

  private get store() {
    return this.edgeless.store;
  }

  private get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  private get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  private get surface() {
    return getSurfaceComponent(this.std);
  }

  private get connectionOverlay() {
    return this.std.get(OverlayIdentifier("connection")) as ConnectionOverlay;
  }

  private text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  /** Synchronizes selection state pushed by `EdgelessSelectedRectWidget`. */
  updateSelection(
    current: ShapeElementModel | NoteBlockModel | null,
    selectedRect: SelectedRect | null,
  ) {
    if (this.disposed) return;
    if (this.current !== current) {
      this.clearLineOverlay();
    }
    this.current = current;
    this.selectedRect = selectedRect;
    this.sync();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.finishPointer();
    this.clearLineOverlay();
    this.clearPanelOverlay();
    if (this.lineOverlay) {
      this.surface?.renderer.removeOverlay(this.lineOverlay);
      this.lineOverlay = null;
    }
    this.panelSession = null;
    this.current = null;
    this.selectedRect = null;
    this.state$.value = null;
    this.disposables.dispose();
    this.chromeHost.remove();
  }

  private setMoving(next: boolean) {
    if (this.isMoving === next) return;
    this.isMoving = next;
    this.sync();
  }

  private isSourceActive(id?: string): boolean {
    const target = this.current;
    if (this.disposed || !target || this.store.readonly) return false;
    const expectedId = id ?? target.id;
    return (
      target.id === expectedId &&
      this.crud.getElementById(expectedId) === target
    );
  }

  private isPanelActive(session: PanelSession | null): session is PanelSession {
    return (
      !this.disposed &&
      !this.store.readonly &&
      session !== null &&
      Boolean(this.crud.getElementById(session.connector.id)) &&
      this.crud.getElementById(session.source.id) === session.source
    );
  }

  private clearLineOverlay() {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.lineOverlay) {
      this.lineOverlay.linePoints = [];
      this.lineOverlay.renderShape = null;
      this.surface?.refresh();
    }
  }

  private clearPanelOverlay() {
    if (this.panelOverlay && this.surface) {
      this.surface.renderer.removeOverlay(this.panelOverlay);
      this.panelOverlay = null;
      this.surface.refresh();
    }
  }

  private finishPointer() {
    if (!this.pointerDisposables) return;
    this.pointerDisposables.dispose();
    this.pointerDisposables = null;
    this.setMoving(false);
    this.connectionOverlay.clear();
    this.std.get(ToolbarRegistryIdentifier).flags.show();
  }

  private addConnector(source: Connection, target: Connection) {
    const id = this.crud.addElement(CanvasElementType.CONNECTOR, {
      source,
      target,
      ...(this.current && isShape(this.current)
        ? { stroke: this.current.strokeColor }
        : {}),
    });
    if (!id) return null;
    return this.crud.getElementById(id) as ConnectorElementModel;
  }

  private getConnectedShapes(element: ShapeElementModel) {
    const surfaceBlock = getSurfaceBlock(this.store);
    if (!surfaceBlock) return [];
    return surfaceBlock.getConnectors(element.id).reduce((acc, conn) => {
      if (conn.target.id === element.id && conn.source.id) {
        acc.push(this.crud.getElementById(conn.source.id) as ShapeElementModel);
      }
      if (conn.source.id === element.id && conn.target.id) {
        acc.push(this.crud.getElementById(conn.target.id) as ShapeElementModel);
      }
      return acc;
    }, [] as ShapeElementModel[]);
  }

  private computeNextBound(
    current: ShapeElementModel | NoteBlockModel,
    direction: Direction,
  ) {
    if (isShape(current)) {
      const connectedShapes = this.getConnectedShapes(current).filter(
        (el): el is ShapeElementModel => el instanceof ShapeElementModel,
      );
      return nextBound(direction, current, connectedShapes);
    }
    const bound = current.elementBound;
    switch (direction) {
      case Direction.Right:
        bound.x += bound.w + MAIN_GAP;
        break;
      case Direction.Bottom:
        bound.y += bound.h + MAIN_GAP;
        break;
      case Direction.Left:
        bound.x -= bound.w + MAIN_GAP;
        break;
      case Direction.Top:
        bound.y -= bound.h + MAIN_GAP;
        break;
    }
    return bound;
  }

  private computeLine(
    direction: Direction,
    shape: ShapeElementModel,
    targetBound: Bound,
  ) {
    const startBound = shape.elementBound;
    const { startPosition, endPosition } = getPosition(direction);
    const nextShape = {
      xywh: targetBound.serialize(),
      rotate: shape.rotate,
      shapeType: shape.shapeType,
    };
    const startPoint = shape.getRelativePointLocation(startPosition);
    const endPoint = shape.getRelativePointLocation.call(
      nextShape,
      endPosition,
    );
    return this.pathGenerator.generateOrthogonalConnectorPath({
      startBound,
      endBound: targetBound,
      startPoint,
      endPoint,
    });
  }

  private showNextShapePreview(
    current: ShapeElementModel,
    bound: Bound,
    path: IVec[],
    targetType: ShapeType,
  ) {
    const surface = this.surface;
    if (!surface || !this.lineOverlay) return;
    this.lineOverlay.stroke = surface.renderer.getColorValue(
      current.strokeColor,
      DefaultTheme.shapeStrokeColor,
      true,
    );
    this.lineOverlay.linePoints = path;
    this.lineOverlay.renderShape = (ctx) => {
      shapeMethods[targetType].draw(ctx, { ...bound, rotate: current.rotate });
    };
    surface.refresh();
  }

  private generateElementOnClick(direction: Direction) {
    if (!this.isSourceActive() || !this.current) return;
    const source = this.current;
    const bound = this.computeNextBound(source, direction);
    const id = createEdgelessElement(this.edgeless, source, bound);
    if (!id) return;

    if (isShape(source)) {
      const { startPosition, endPosition } = getPosition(direction);
      this.addConnector(
        { id: source.id, position: startPosition },
        { id, position: endPosition },
      );
      mountShapeTextEditor(
        this.crud.getElementById(id) as ShapeElementModel,
        this.edgeless,
      );
    } else {
      const model = this.store.getModelById(id);
      if (!model) return;
      const [x, y] = this.gfx.viewport.toViewCoord(
        bound.center[0],
        bound.y + DEFAULT_NOTE_HEIGHT / 2,
      );
      this.edgeless.host.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        handleNativeRangeAtPoint(x, y);
      });
    }

    this.gfx.selection.set({ elements: [id], editing: true });
    this.clearLineOverlay();
  }

  private handlePointerDown(event: PointerEvent, direction: Direction) {
    if (!this.isSourceActive() || !this.current) return;
    this.pointerDisposables?.dispose();
    this.pointerDisposables = new DisposableGroup();
    const source = this.current;
    const sourceId = source.id;
    const viewportRect = this.gfx.viewport.boundingClientRect;
    const start = this.gfx.viewport.toModelCoord(
      event.clientX - viewportRect.left,
      event.clientY - viewportRect.top,
    );
    if (!this.std.event) return;

    const pointerId = event.pointerId;
    let connector: ConnectorElementModel | null = null;

    this.pointerDisposables.addFromEvent(
      document,
      "pointermove",
      (moveEvent) => {
        if (
          moveEvent.pointerId !== pointerId ||
          !this.isSourceActive(sourceId)
        ) {
          return;
        }
        const point = this.gfx.viewport.toModelCoord(
          moveEvent.clientX - viewportRect.left,
          moveEvent.clientY - viewportRect.top,
        );
        if (Vec.dist(start, point) > 8 && !this.isMoving) {
          if (!isShape(source) && !isNoteBlock(source)) return;
          this.setMoving(true);
          const { startPosition } = getPosition(direction);
          connector = this.addConnector(
            { id: source.id, position: startPosition },
            { position: point },
          );
        }
        if (this.isMoving && connector) {
          const otherSideId = connector.source.id;
          connector.target = this.connectionOverlay.renderConnector(
            point,
            otherSideId ? [otherSideId] : [],
          );
          this.std.get(ToolbarRegistryIdentifier).flags.hide();
        }
      },
    );

    this.pointerDisposables.addFromEvent(document, "pointerup", (upEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (!this.isSourceActive(sourceId)) {
        this.finishPointer();
        return;
      }
      if (!this.isMoving) {
        this.generateElementOnClick(direction);
      } else if (connector && !connector.target.id) {
        this.gfx.selection.clear();
        this.openPanel(upEvent, source, connector);
      }
      this.finishPointer();
    });

    this.pointerDisposables.addFromEvent(document, "pointercancel", () =>
      this.finishPointer(),
    );
  }

  private openPanel(
    event: PointerEvent,
    source: ShapeElementModel | NoteBlockModel,
    connector: ConnectorElementModel,
  ) {
    if (!isShape(source) && !isNoteBlock(source)) return;
    this.clearPanelOverlay();
    const rect = this.gfx.viewport.boundingClientRect;
    const position = this.gfx.viewport.toModelCoord(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    this.panelSession = { position, source, connector };
    this.sync();
  }

  private closePanel(restoreFocus = false) {
    this.clearPanelOverlay();
    this.panelSession = null;
    this.sync();
    if (restoreFocus) {
      this.edgeless.host.focus({ preventScroll: true });
    }
  }

  private generatePanelTarget(session: PanelSession) {
    let w = SHAPE_OVERLAY_WIDTH;
    let h = SHAPE_OVERLAY_HEIGHT;
    if (isShape(session.source)) {
      const bound = Bound.deserialize(session.source.xywh);
      w = bound.w;
      h = bound.h;
    }
    const point = session.connector.target.position;
    if (!point) return null;
    const pathLen = session.connector.path.length;
    const angle = normalizeDegAngle(
      toDegree(
        Vec.angle(
          session.connector.path[pathLen - 2],
          session.connector.path[pathLen - 1],
        ),
      ),
    );
    let targetBound: Bound;
    let position: Connection["position"];
    let direction: Direction;

    if (angle >= 45 && angle <= 135) {
      targetBound = new Bound(point[0] - w / 2, point[1], w, h);
      position = [0.5, 0];
      direction = Direction.Bottom;
    } else if (angle >= 135 && angle <= 225) {
      targetBound = new Bound(point[0] - w, point[1] - h / 2, w, h);
      position = [1, 0.5];
      direction = Direction.Left;
    } else if (angle >= 225 && angle <= 315) {
      targetBound = new Bound(point[0] - w / 2, point[1] - h, w, h);
      position = [0.5, 1];
      direction = Direction.Top;
    } else {
      targetBound = new Bound(point[0], point[1] - h / 2, w, h);
      position = [0, 0.5];
      direction = Direction.Right;
    }
    return { nextBound: targetBound, position, direction };
  }

  private getPanelTargetXYWH(
    session: PanelSession,
    width: number,
    height: number,
  ) {
    const result = this.generatePanelTarget(session);
    if (!result) return null;
    const { nextBound: bound, direction, position } = result;
    const { w, h } = bound;
    let x = bound.x;
    let y = bound.y;
    switch (direction) {
      case Direction.Right:
        y += h / 2 - height / 2;
        break;
      case Direction.Bottom:
        x -= width / 2 - w / 2;
        break;
      case Direction.Left:
        y += h / 2 - height / 2;
        x -= width - w;
        break;
      case Direction.Top:
        x -= width / 2 - w / 2;
        y += h - height;
        break;
    }
    return { xywh: [x, y, width, height] as XYWH, position };
  }

  private showPanelOverlay(
    session: PanelSession,
    targetType: AUTO_COMPLETE_TARGET_TYPE,
  ) {
    this.clearPanelOverlay();
    if (!this.isPanelActive(session) || !this.surface) return;

    if (targetType === "text") {
      const xywh = this.getPanelTargetXYWH(
        session,
        DEFAULT_TEXT_WIDTH,
        DEFAULT_TEXT_HEIGHT,
      )?.xywh;
      if (!xywh) return;
      this.panelOverlay = new AutoCompleteTextOverlay(this.gfx, xywh);
    } else if (targetType === "note") {
      const xywh = this.getPanelTargetXYWH(
        session,
        DEFAULT_NOTE_WIDTH,
        DEFAULT_NOTE_OVERLAY_HEIGHT,
      )?.xywh;
      if (!xywh) return;
      const background = this.std
        .get(ThemeProvider)
        .getColorValue(
          this.std.get(EditPropsStore).lastProps$.value["myoxus:note"]
            .background,
          DefaultTheme.noteBackgrounColor,
          true,
        );
      this.panelOverlay = new AutoCompleteNoteOverlay(
        this.gfx,
        xywh,
        background,
      );
    } else if (targetType === "frame") {
      const bound = this.generatePanelTarget(session)?.nextBound;
      if (!bound) return;
      const h = bound.h;
      const w = h / 0.75;
      const xywh = this.getPanelTargetXYWH(session, w, h)?.xywh;
      if (!xywh) return;
      const strokeColor = this.std
        .get(ThemeProvider)
        .getCssVariableColor("--myoxus-black-30");
      this.panelOverlay = new AutoCompleteFrameOverlay(
        this.gfx,
        xywh,
        strokeColor,
      );
    } else {
      const bound = this.generatePanelTarget(session)?.nextBound;
      if (!bound) return;
      const xywh = [bound.x, bound.y, bound.w, bound.h] as XYWH;
      const { shapeStyle, strokeColor, fillColor, strokeWidth, roughness } =
        this.std.get(EditPropsStore).lastProps$.value[`shape:${targetType}`];
      const themeProvider = this.std.get(ThemeProvider);
      const stroke = themeProvider.getColorValue(
        strokeColor,
        DefaultTheme.shapeStrokeColor,
        true,
      );
      const fill = themeProvider.getColorValue(
        fillColor,
        DefaultTheme.shapeFillColor,
        true,
      );
      this.panelOverlay = new AutoCompleteShapeOverlay(
        this.gfx,
        xywh,
        targetType,
        {
          seed: 666,
          roughness,
          strokeLineDash: [0, 0],
          stroke,
          strokeWidth,
          fill,
        },
        shapeStyle,
      );
    }

    this.surface.renderer.addOverlay(this.panelOverlay);
    this.surface.refresh();
  }

  private commitPanelChoice(
    session: PanelSession,
    targetType: AUTO_COMPLETE_TARGET_TYPE,
  ) {
    this.clearPanelOverlay();
    if (!this.isPanelActive(session)) {
      this.closePanel();
      return;
    }

    if (targetType === "note" || targetType === "frame") {
      this.edgeless.host.focus({ preventScroll: true });
    }

    if (targetType === "text") {
      const target = this.getPanelTargetXYWH(
        session,
        DEFAULT_TEXT_WIDTH,
        DEFAULT_TEXT_HEIGHT,
      );
      if (target) {
        const bound = Bound.fromXYWH(target.xywh);
        const [, { textId }] = this.std.command.exec(
          insertEdgelessTextCommand,
          { x: bound.x, y: bound.y },
        );
        const textElement = textId ? this.crud.getElementById(textId) : null;
        if (textId && textElement) {
          this.crud.updateElement(session.connector.id, {
            target: { id: textId, position: target.position },
          });
          if (session.source.group instanceof GroupElementModel) {
            session.source.group.addChild(textElement);
          }
          this.gfx.selection.set({ elements: [textId], editing: false });
          this.store.captureSync();
        }
      }
    } else if (targetType === "note") {
      const target = this.getPanelTargetXYWH(
        session,
        DEFAULT_NOTE_WIDTH,
        DEFAULT_NOTE_OVERLAY_HEIGHT,
      );
      if (target) {
        const id = this.crud.addBlock(
          "myoxus:note",
          { xywh: serializeXYWH(...target.xywh) },
          this.store.root?.id,
        );
        const note = this.store.getBlock(id)?.model;
        if (matchModels(note, [NoteBlockModel])) {
          this.store.addBlock("myoxus:paragraph", { type: "text" }, id);
          if (session.source.group instanceof GroupElementModel) {
            session.source.group.addChild(note);
          }
          session.connector.target = {
            id,
            position: target.position as [number, number],
          };
          this.crud.updateElement(session.connector.id, {
            target: { id, position: target.position },
          });
          this.gfx.selection.set({ elements: [id], editing: false });
        }
      }
    } else if (targetType === "frame") {
      const bound = this.generatePanelTarget(session)?.nextBound;
      const surfaceBlockModel = getSurfaceBlock(this.store);
      if (bound && surfaceBlockModel) {
        const h = bound.h;
        const w = h / 0.75;
        const target = this.getPanelTargetXYWH(session, w, h);
        if (target) {
          const frameMgr = this.std.get(EdgelessFrameManagerIdentifier);
          const props = this.std
            .get(EditPropsStore)
            .applyLastProps("myoxus:frame", {
              title: new Y.Text(`Frame ${frameMgr.frames.length + 1}`),
              xywh: serializeXYWH(...target.xywh),
              presentationIndex: frameMgr.generatePresentationIndex(),
            });
          const id = this.crud.addBlock(
            "myoxus:frame",
            props,
            surfaceBlockModel,
          );
          this.store.captureSync();
          const frame = this.crud.getElementById(id);
          if (frame) {
            session.connector.target = { id, position: target.position };
            this.gfx.selection.set({ elements: [frame.id], editing: false });
          }
        }
      }
    } else {
      const result = this.generatePanelTarget(session);
      if (result) {
        const id = createShapeElement(
          this.edgeless,
          session.source,
          targetType as TARGET_SHAPE_TYPE,
        );
        if (id) {
          this.crud.updateElement(id, { xywh: result.nextBound.serialize() });
          this.crud.updateElement(session.connector.id, {
            target: { id, position: result.position },
          });
          mountShapeTextEditor(
            this.crud.getElementById(id) as ShapeElementModel,
            this.edgeless,
          );
          this.gfx.selection.set({ elements: [id], editing: true });
          this.store.captureSync();
        }
      }
    }

    this.closePanel();
  }

  private buildTriggers(): EditorAutoCompleteControls["triggers"] {
    if (!this.isSourceActive() || !this.current || !this.selectedRect) {
      return null;
    }
    const source = this.current;
    const sourceId = source.id;
    const selectedRect = this.selectedRect;
    const shapeSource = source instanceof ShapeElementModel;
    const owner = source.group;
    const view = owner && this.gfx.view.get(owner);
    const familyActions =
      view instanceof GfxElementModelView
        ? view.getSelectionActions(source, selectedRect, this.gfx.viewport.zoom)
        : null;

    const canAutoComplete =
      this.gfx.selection.selectedElements.length === 1 &&
      (this.gfx.selection.selectedElements[0] instanceof ShapeElementModel ||
        isNoteBlock(this.gfx.selection.selectedElements[0]));

    if (
      (owner &&
        "managesChildMembership" in owner &&
        owner.managesChildMembership &&
        !familyActions) ||
      this.isMoving ||
      (this.isHover && !shapeSource && !canAutoComplete)
    ) {
      this.clearLineOverlay();
      return null;
    }

    const rect = {
      left: selectedRect.left,
      top: selectedRect.top,
      width: selectedRect.width,
      height: selectedRect.height,
      rotate: selectedRect.rotate,
    };

    if (familyActions) {
      return {
        rect,
        items: familyActions.map((action) => ({
          key: `family:${action.id}`,
          family: true,
          width: 26,
          height: 26,
          transform: `translate(${action.left}px, ${action.top}px)${action.mirrored ? " scale(-1)" : ""} translate(-13px, -13px)`,
          label: action.id,
          icon: action.icon,
          preview: () => {},
          pointerDown: () => {
            if (this.isSourceActive(sourceId)) action.run();
          },
          activate: () => {
            if (this.isSourceActive(sourceId)) action.run();
          },
        })),
      };
    }

    const zoom = this.gfx.viewport.zoom;
    const width = 72;
    const height = 44;
    const directions = shapeSource
      ? [Direction.Right, Direction.Bottom, Direction.Left, Direction.Top]
      : [Direction.Right, Direction.Left];
    const arrowMargin = shapeSource ? height / 2 : height * (2 / 3);
    const directionLabels: Record<Direction, EditorI18nMessage> = {
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
    };

    return {
      rect,
      items: directions.map((direction) => {
        const { startPosition } = getPosition(direction);
        const [horizontal, vertical] = startPosition;
        const x =
          selectedRect.width * horizontal +
          (horizontal - 0.5) * 2 * arrowMargin;
        const y =
          selectedRect.height * vertical + (vertical - 0.5) * 2 * arrowMargin;
        const transform = `translate(${x}px, ${y}px)${shapeSource ? `rotate(${(direction + 1) * 90}deg)` : ""} translate(${-width / 2}px, ${-height / 2}px)`;

        return {
          key: String(direction),
          family: false,
          hidden: !shapeSource && direction === Direction.Left && zoom >= 1.5,
          width,
          height,
          transform,
          label: this.text(directionLabels[direction]),
          icon: shapeSource ? "ArrowUpBigIcon" : "PlusIcon",
          preview: (active) => {
            this.clearLineOverlay();
            if (active && this.isSourceActive(sourceId) && isShape(source)) {
              this.hoverTimer = setTimeout(() => {
                if (!this.isSourceActive(sourceId) || !isShape(source)) return;
                const bound = this.computeNextBound(source, direction);
                this.showNextShapePreview(
                  source,
                  bound,
                  this.computeLine(direction, source, bound),
                  source.shapeType,
                );
              }, 300);
            }
          },
          pointerDown: (event) => {
            if (this.isSourceActive(sourceId)) {
              this.handlePointerDown(event, direction);
            }
          },
          activate: () => {
            if (this.isSourceActive(sourceId)) {
              this.generateElementOnClick(direction);
            }
          },
        };
      }),
    };
  }

  private buildPanel(): EditorAutoCompleteControls["panel"] {
    if (!this.isPanelActive(this.panelSession)) {
      this.clearPanelOverlay();
      this.panelSession = null;
      return null;
    }
    const session = this.panelSession;
    const [left, top] = this.gfx.viewport.toViewCoord(...session.position);
    const makeOption = (
      id: AUTO_COMPLETE_TARGET_TYPE,
      label: string,
      icon: MyoxusIconExportName,
    ) => ({
      label,
      icon,
      preview: (active: boolean) =>
        active ? this.showPanelOverlay(session, id) : this.clearPanelOverlay(),
      choose: () => this.commitPanelChoice(session, id),
    });

    return {
      left,
      top,
      label: this.text(
        editorMessage(
          "com.myoxus.editor.canvas.add-same-object",
          "Add another object of this type",
        ),
      ),
      options: [
        ...ShapeComponentConfig.map(({ name, iconName, tooltip }) =>
          makeOption(name, this.text(tooltip), iconName),
        ),
        makeOption(
          "text",
          this.text(editorMessage("Text", "Text")),
          "FontIcon",
        ),
        makeOption(
          "note",
          this.text(
            editorMessage(
              "com.myoxus.settings.editorSettings.edgeless.note",
              "Note",
            ),
          ),
          "PageIcon",
        ),
        makeOption(
          "frame",
          this.text(
            editorMessage("com.myoxus.editor.drag.frame-block", "Frame"),
          ),
          "FrameIcon",
        ),
        makeOption(
          isShape(session.source)
            ? getShapeName(session.source.shapeType, session.source.radius)
            : "note",
          this.text(
            editorMessage(
              "com.myoxus.editor.canvas.add-same-object",
              "Add another object of this type",
            ),
          ),
          "DuplicateIcon",
        ),
      ],
      close: () => this.closePanel(true),
    };
  }

  private sync() {
    if (this.disposed) return;
    const triggers = this.buildTriggers();
    const panel = this.buildPanel();
    this.state$.value = triggers || panel ? { triggers, panel } : null;
  }
}
