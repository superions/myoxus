import { consume } from "@lit/context";
import { EdgelessFrameManagerIdentifier } from "../../blocks/frame/index";
import {
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
  getSurfaceComponent,
} from "@virgultum/canvas-runtime/surface";
import {
  mountShapeTextEditor,
  SHAPE_OVERLAY_HEIGHT,
  SHAPE_OVERLAY_WIDTH,
  ShapeComponentConfig,
} from "../../gfx/shape/index";
import { insertEdgelessTextCommand } from "../../gfx/text/index";
import {
  Bound,
  normalizeDegAngle,
  serializeXYWH,
  toDegree,
  Vec,
  type XYWH,
} from "@virgultum/core/primitives/gfx";
import { WithDisposable, SignalWatcher } from "@virgultum/core/primitives/lit";
import {
  type Connection,
  type ConnectorElementModel,
  DEFAULT_NOTE_WIDTH,
  DefaultTheme,
  getShapeName,
  GroupElementModel,
  NoteBlockModel,
  type ShapeElementModel,
} from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  EditPropsStore,
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";
import {
  type BlockComponent,
  type BlockStdScope,
  stdContext,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import * as Y from "yjs";

import {
  type AUTO_COMPLETE_TARGET_TYPE,
  AutoCompleteFrameOverlay,
  AutoCompleteNoteOverlay,
  AutoCompleteShapeOverlay,
  AutoCompleteTextOverlay,
  createShapeElement,
  DEFAULT_NOTE_OVERLAY_HEIGHT,
  DEFAULT_TEXT_HEIGHT,
  DEFAULT_TEXT_WIDTH,
  Direction,
  isShape,
  type TARGET_SHAPE_TYPE,
} from "./utils.js";

export class EdgelessAutoCompletePanel extends SignalWatcher(
  WithDisposable(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private _overlay:
    | AutoCompleteShapeOverlay
    | AutoCompleteNoteOverlay
    | AutoCompleteFrameOverlay
    | AutoCompleteTextOverlay
    | null = null;

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  constructor(
    position: [number, number],
    edgeless: BlockComponent,
    currentSource: ShapeElementModel | NoteBlockModel,
    connector: ConnectorElementModel,
  ) {
    super();
    this.position = position;
    this.edgeless = edgeless;
    this.currentSource = currentSource;
    this.connector = connector;
  }

  get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  get surface() {
    return getSurfaceComponent(this.std);
  }

  private _addFrame() {
    const bound = this._generateTarget(this.connector)?.nextBound;
    if (!bound) return;

    const { h } = bound;
    const w = h / 0.75;
    const target = this._getTargetXYWH(w, h);
    if (!target) return;

    const { xywh, position } = target;

    const edgeless = this.edgeless;
    const surfaceBlockModel = getSurfaceBlock(this.std.store);
    if (!surfaceBlockModel) return;
    const frameMgr = this.std.get(EdgelessFrameManagerIdentifier);
    const frameIndex = frameMgr.frames.length + 1;
    const props = this.std.get(EditPropsStore).applyLastProps("myoxus:frame", {
      title: new Y.Text(`Frame ${frameIndex}`),
      xywh: serializeXYWH(...xywh),
      presentationIndex: frameMgr.generatePresentationIndex(),
    });
    const id = this.crud.addBlock("myoxus:frame", props, surfaceBlockModel);
    edgeless.store.captureSync();
    const frame = this.crud.getElementById(id);
    if (!frame) return;

    this.connector.target = {
      id,
      position,
    };

    this.gfx.selection.set({
      elements: [frame.id],
      editing: false,
    });
  }

  private _addNote() {
    const { store } = this.edgeless;
    const target = this._getTargetXYWH(
      DEFAULT_NOTE_WIDTH,
      DEFAULT_NOTE_OVERLAY_HEIGHT,
    );
    if (!target) return;

    const { xywh, position } = target;
    const id = this.crud.addBlock(
      "myoxus:note",
      {
        xywh: serializeXYWH(...xywh),
      },
      store.root?.id,
    );
    const note = store.getBlock(id)?.model;
    if (!matchModels(note, [NoteBlockModel])) {
      return;
    }
    store.addBlock("myoxus:paragraph", { type: "text" }, id);
    const group = this.currentSource.group;

    if (group instanceof GroupElementModel) {
      group.addChild(note);
    }
    this.connector.target = {
      id,
      position: position as [number, number],
    };
    this.crud.updateElement(this.connector.id, {
      target: { id, position },
    });
    this.gfx.selection.set({
      elements: [id],
      editing: false,
    });
  }

  private _addShape(targetType: TARGET_SHAPE_TYPE) {
    const edgeless = this.edgeless;
    const result = this._generateTarget(this.connector);
    if (!result) return;

    const currentSource = this.currentSource;
    const { nextBound, position } = result;
    const id = createShapeElement(edgeless, currentSource, targetType);
    if (!id) return;

    this.crud.updateElement(id, { xywh: nextBound.serialize() });
    this.crud.updateElement(this.connector.id, {
      target: { id, position },
    });

    mountShapeTextEditor(
      this.crud.getElementById(id) as ShapeElementModel,
      this.edgeless,
    );
    this.gfx.selection.set({
      elements: [id],
      editing: true,
    });
    edgeless.store.captureSync();
  }

  private _addText() {
    const target = this._getTargetXYWH(DEFAULT_TEXT_WIDTH, DEFAULT_TEXT_HEIGHT);
    if (!target) return;
    const { xywh, position } = target;
    const bound = Bound.fromXYWH(xywh);

    const [_, { textId }] = this.edgeless.std.command.exec(
      insertEdgelessTextCommand,
      {
        x: bound.x,
        y: bound.y,
      },
    );
    if (!textId) return;

    const textElement = this.crud.getElementById(textId);
    if (!textElement) return;

    this.crud.updateElement(this.connector.id, {
      target: { id: textId, position },
    });
    if (this.currentSource.group instanceof GroupElementModel) {
      this.currentSource.group.addChild(textElement);
    }

    this.gfx.selection.set({
      elements: [textId],
      editing: false,
    });
    this.edgeless.store.captureSync();
  }

  private _autoComplete(targetType: AUTO_COMPLETE_TARGET_TYPE) {
    this._removeOverlay();
    if (!this._active()) return;

    if (targetType === "note" || targetType === "frame") {
      // These branches select canvas objects without an inline editor taking focus.
      this.edgeless.host.focus({ preventScroll: true });
    }
    switch (targetType) {
      case "text":
        this._addText();
        break;
      case "note":
        this._addNote();
        break;
      case "frame":
        this._addFrame();
        break;
      default:
        this._addShape(targetType);
    }

    this.remove();
  }

  private _generateTarget(connector: ConnectorElementModel) {
    const { currentSource } = this;
    let w = SHAPE_OVERLAY_WIDTH;
    let h = SHAPE_OVERLAY_HEIGHT;
    if (isShape(currentSource)) {
      const bound = Bound.deserialize(currentSource.xywh);
      w = bound.w;
      h = bound.h;
    }
    const point = connector.target.position;
    if (!point) return;

    const len = connector.path.length;
    const angle = normalizeDegAngle(
      toDegree(Vec.angle(connector.path[len - 2], connector.path[len - 1])),
    );
    let nextBound: Bound;
    let position: Connection["position"];
    // direction of the connector target arrow
    let direction: Direction;

    if (angle >= 45 && angle <= 135) {
      nextBound = new Bound(point[0] - w / 2, point[1], w, h);
      position = [0.5, 0];
      direction = Direction.Bottom;
    } else if (angle >= 135 && angle <= 225) {
      nextBound = new Bound(point[0] - w, point[1] - h / 2, w, h);
      position = [1, 0.5];
      direction = Direction.Left;
    } else if (angle >= 225 && angle <= 315) {
      nextBound = new Bound(point[0] - w / 2, point[1] - h, w, h);
      position = [0.5, 1];
      direction = Direction.Top;
    } else {
      nextBound = new Bound(point[0], point[1] - h / 2, w, h);
      position = [0, 0.5];
      direction = Direction.Right;
    }

    return { nextBound, position, direction };
  }

  private _active() {
    return (
      this.isConnected &&
      !this.std.store.readonly &&
      !!this.crud.getElementById(this.connector.id) &&
      this.crud.getElementById(this.currentSource.id) === this.currentSource
    );
  }

  private _getTargetXYWH(width: number, height: number) {
    const result = this._generateTarget(this.connector);
    if (!result) return null;

    const { nextBound: bound, direction, position } = result;
    if (!bound) return null;

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

    const xywh = [x, y, width, height] as XYWH;

    return { xywh, position };
  }

  private _removeOverlay() {
    if (this._overlay && this.surface) {
      this.surface.renderer.removeOverlay(this._overlay);
      this._overlay = null;
      this.surface.refresh();
    }
  }

  private _showFrameOverlay() {
    if (!this.surface) return;

    const bound = this._generateTarget(this.connector)?.nextBound;
    if (!bound) return;

    const { h } = bound;
    const w = h / 0.75;
    const xywh = this._getTargetXYWH(w, h)?.xywh;
    if (!xywh) return;

    const strokeColor = this.std
      .get(ThemeProvider)
      .getCssVariableColor("--myoxus-black-30");
    this._overlay = new AutoCompleteFrameOverlay(this.gfx, xywh, strokeColor);
    this.surface.renderer.addOverlay(this._overlay);
  }

  private _showNoteOverlay() {
    const xywh = this._getTargetXYWH(
      DEFAULT_NOTE_WIDTH,
      DEFAULT_NOTE_OVERLAY_HEIGHT,
    )?.xywh;
    if (!xywh) return;
    if (!this.surface) return;

    const background = this.edgeless.std
      .get(ThemeProvider)
      .getColorValue(
        this.edgeless.std.get(EditPropsStore).lastProps$.value["myoxus:note"]
          .background,
        DefaultTheme.noteBackgrounColor,
        true,
      );
    this._overlay = new AutoCompleteNoteOverlay(this.gfx, xywh, background);
    this.surface.renderer.addOverlay(this._overlay);
  }

  private _showOverlay(targetType: AUTO_COMPLETE_TARGET_TYPE) {
    this._removeOverlay();
    if (!this._active()) return;
    if (!this.surface) return;

    switch (targetType) {
      case "text":
        this._showTextOverlay();
        break;
      case "note":
        this._showNoteOverlay();
        break;
      case "frame":
        this._showFrameOverlay();
        break;
      default:
        this._showShapeOverlay(targetType);
    }

    this.surface.refresh();
  }

  private _showShapeOverlay(targetType: TARGET_SHAPE_TYPE) {
    const bound = this._generateTarget(this.connector)?.nextBound;
    if (!bound) return;
    if (!this.surface) return;

    const { x, y, w, h } = bound;
    const xywh = [x, y, w, h] as XYWH;
    const { shapeStyle, strokeColor, fillColor, strokeWidth, roughness } =
      this.edgeless.std.get(EditPropsStore).lastProps$.value[
        `shape:${targetType}`
      ];

    const stroke = this.edgeless.std
      .get(ThemeProvider)
      .getColorValue(strokeColor, DefaultTheme.shapeStrokeColor, true);
    const fill = this.edgeless.std
      .get(ThemeProvider)
      .getColorValue(fillColor, DefaultTheme.shapeFillColor, true);

    const options = {
      seed: 666,
      roughness: roughness,
      strokeLineDash: [0, 0],
      stroke,
      strokeWidth,
      fill,
    };

    this._overlay = new AutoCompleteShapeOverlay(
      this.gfx,
      xywh,
      targetType,
      options,
      shapeStyle,
    );

    this.surface.renderer.addOverlay(this._overlay);
  }

  private _showTextOverlay() {
    const xywh = this._getTargetXYWH(
      DEFAULT_TEXT_WIDTH,
      DEFAULT_TEXT_HEIGHT,
    )?.xywh;
    if (!xywh) return;
    if (!this.surface) return;

    this._overlay = new AutoCompleteTextOverlay(this.gfx, xywh);
    this.surface.renderer.addOverlay(this._overlay);
  }

  override disconnectedCallback() {
    this._removeOverlay();
    super.disconnectedCallback();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => this.requestUpdate()),
    );
    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe(() => this.requestUpdate()),
    );
    const surface = this.gfx.surface;
    if (surface)
      this.disposables.add(
        surface.elementRemoved.subscribe(() => this.requestUpdate()),
      );
  }

  override createRenderRoot() {
    return this;
  }

  override render() {
    const host = this.std.getOptional(EditorChromeHostIdentifier);
    if (!host || !this._active()) {
      this._removeOverlay();
      return nothing;
    }
    const point = this.gfx.viewport.toViewCoord(...this.position);
    const option = (
      id: AUTO_COMPLETE_TARGET_TYPE,
      label: string,
      icon: import("@myoxus/icons/names").MyoxusIconExportName,
    ) => ({
      label,
      icon,
      preview: (active: boolean) =>
        active ? this._showOverlay(id) : this._removeOverlay(),
      choose: () => this._autoComplete(id),
    });
    const options = [
      ...ShapeComponentConfig.map(({ name, iconName, tooltip }) =>
        option(name, this._text(tooltip), iconName),
      ),
      option("text", this._text(editorMessage("Text", "Text")), "FontIcon"),
      option(
        "note",
        this._text(
          editorMessage(
            "com.myoxus.settings.editorSettings.edgeless.note",
            "Note",
          ),
        ),
        "PageIcon",
      ),
      option(
        "frame",
        this._text(
          editorMessage("com.myoxus.editor.drag.frame-block", "Frame"),
        ),
        "FrameIcon",
      ),
      option(
        isShape(this.currentSource)
          ? getShapeName(
              this.currentSource.shapeType,
              this.currentSource.radius,
            )
          : "note",
        this._text(
          editorMessage(
            "com.myoxus.editor.canvas.add-same-object",
            "Add another object of this type",
          ),
        ),
        "DuplicateIcon",
      ),
    ];
    return host.renderAutoCompletePanel({
      label: this._text(
        editorMessage(
          "com.myoxus.editor.canvas.add-same-object",
          "Add another object of this type",
        ),
      ),
      options,
      // Only the renderer-owned anchor follows world coordinates; Mantine owns menu size/flip/clipping.
      setAnchor: (anchor) => {
        if (!anchor) return;
        Object.assign(anchor.style, {
          position: "absolute",
          left: `${point[0]}px`,
          top: `${point[1]}px`,
          width: "1px",
          height: "1px",
        });
      },
      close: () => {
        this.remove();
        this.edgeless.host.focus({ preventScroll: true });
      },
    });
  }

  @property({ attribute: false })
  accessor connector: ConnectorElementModel;

  @property({ attribute: false })
  accessor currentSource: ShapeElementModel | NoteBlockModel;

  @property({ attribute: false })
  accessor edgeless: BlockComponent;

  @property({ attribute: false })
  accessor position: [number, number];

  @consume({
    context: stdContext,
  })
  accessor std!: BlockStdScope;
}
