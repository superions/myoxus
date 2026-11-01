import {
  Bound,
  curveIntersects,
  getBezierNearestPoint,
  getBezierNearestTime,
  getBezierParameters,
  getBezierPoint,
  type IVec,
  linePolylineIntersects,
  PointLocation,
  Polyline,
  polyLineNearestPoint,
  type SerializedXYWH,
  Vec,
  type XYWH,
} from "@virgultum/global/gfx";
import {
  type BaseElementProps,
  derive,
  field,
  GfxPrimitiveElementModel,
  local,
  type PointTestOptions,
  type SerializedElement,
} from "@virgultum/std/gfx";
import * as Y from "yjs";

import {
  CONNECTOR_LABEL_MAX_WIDTH,
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
  DEFAULT_CONNECTOR_MODE,
  DEFAULT_ROUGHNESS,
  FontFamily,
  FontStyle,
  FontWeight,
  type PointStyle,
  StrokeStyle,
  TextAlign,
  type TextStyleProps,
} from "../../consts/index";
import { type Color, DefaultTheme } from "../../themes/index";

export type SerializedConnection = {
  id?: string;
  position?: `[${number},${number}]` | PointLocation;
};

// at least one of id and position is not null
// both exists means the position is relative to the element
export type Connection = {
  id?: string;
  position?: [number, number];
};

export const getConnectorModeName = (mode: ConnectorMode) => {
  return {
    [ConnectorMode.Straight]: "Straight",
    [ConnectorMode.Orthogonal]: "Elbowed",
    [ConnectorMode.Curve]: "Curve",
  }[mode];
};

export type ConnectorLabelOffsetProps = {
  // [0, 1], `0.5` by default
  distance: number;
  // `center` by default
  anchor?: ConnectorLabelOffsetAnchor;
};

export type ConnectorLabelConstraintsProps = {
  hasMaxWidth: boolean;
  maxWidth: number;
};

export type ConnectorLabelProps = {
  // Label's content
  text?: Y.Text;
  labelEditing?: boolean;
  labelDisplay?: boolean;
  labelXYWH?: XYWH;
  labelOffset?: ConnectorLabelOffsetProps;
  labelStyle?: TextStyleProps;
  labelConstraints?: ConnectorLabelConstraintsProps;
};

export type SerializedConnectorElement = SerializedElement & {
  source: SerializedConnection;
  target: SerializedConnection;
};

export type ConnectorElementProps = BaseElementProps & {
  mode: ConnectorMode;
  stroke: Color;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness?: number;
  rough?: boolean;
  source: Connection;
  target: Connection;

  /** Optional marker scale independent of the line width. */
  endpointScale?: number | null;
  /** Geometry dependencies for obstacle-aware routing, separate from endpoints. */
  routingObstacleIds?: string[];
  labelObstacleIds?: string[];
  routingObstacleRegions?: Record<
    string,
    readonly [number, number, number, number]
  >;
  routingClearance?: number;
  /** Local rendering of obstacle-routed corners; never a document reference. */
  routingCornerRadius?: number;
  routingLaneOffset?: number;
  frontEndpointStyle?: PointStyle;
  rearEndpointStyle?: PointStyle;
  /** Independent endpoint decoration; it does not replace an arrow marker. */
  frontEndpointCircle?: boolean;
  rearEndpointCircle?: boolean;
} & ConnectorLabelProps;

export class ConnectorElementModel extends GfxPrimitiveElementModel<ConnectorElementProps> {
  updatingPath = false;

  /**
   * Connectors should always render, even during zoom.
   */
  forceFullRender = true;

  override get connectable() {
    return false as const;
  }

  get connected() {
    return !!(this.source.id || this.target.id);
  }

  override get elementBound() {
    let bounds = super.elementBound;
    if (this.hasLabel()) {
      bounds = bounds.unite(Bound.fromXYWH(this.labelXYWH!));
    }
    return bounds;
  }

  get type() {
    return "connector";
  }

  static propsToY(props: ConnectorElementProps) {
    if (typeof props.text === "string") {
      props.text = new Y.Text(props.text);
    }

    return props;
  }

  override containsBound(bounds: Bound) {
    return (
      this.absolutePath.some((point) => bounds.containsPoint(point)) ||
      (this.hasLabel() &&
        Bound.fromXYWH(this.labelXYWH!).points.some((p) =>
          bounds.containsPoint(p),
        ))
    );
  }

  override getLineIntersections(start: IVec, end: IVec) {
    const { mode, absolutePath: path } = this;

    let intersected = null;

    if (mode === ConnectorMode.Curve && path.length > 1) {
      intersected = curveIntersects(path, [start, end]);
    } else {
      intersected = linePolylineIntersects(start, end, path);
    }

    if (!intersected && this.hasLabel()) {
      intersected = linePolylineIntersects(
        start,
        end,
        Bound.fromXYWH(this.labelXYWH!).points,
      );
    }

    return intersected;
  }

  /**
   * Calculate the closest point on the curve via a point.
   */
  override getNearestPoint(point: IVec): IVec {
    const { mode, absolutePath: path } = this;

    if (mode === ConnectorMode.Straight) {
      const first = path[0];
      const last = path[path.length - 1];
      return Vec.nearestPointOnLineSegment(first, last, point, true);
    }

    if (mode === ConnectorMode.Orthogonal) {
      const points = path.map<IVec>((p) => [p[0], p[1]]);
      return Polyline.nearestPoint(points, point);
    }

    const b = getBezierParameters(path);
    const t = getBezierNearestTime(b, point);
    const p = getBezierPoint(b, t);
    if (p) return p;

    const { x, y } = this;
    return [x, y];
  }

  /**
   * Calculating the computed distance along a path via a point.
   *
   * The point is relative to the viewport.
   */
  getOffsetDistanceByPoint(point: IVec, bounds?: Bound) {
    const { mode, absolutePath: path } = this;

    let { x, y, w, h } = this;
    if (bounds) {
      x = bounds.x;
      y = bounds.y;
      w = bounds.w;
      h = bounds.h;
    }

    point[0] = Vec.clamp(point[0], x, x + w);
    point[1] = Vec.clamp(point[1], y, y + h);

    if (mode === ConnectorMode.Straight) {
      const s = path[0];
      const e = path[path.length - 1];
      const pl = Vec.dist(s, point);
      const fl = Vec.dist(s, e);
      return pl / fl;
    }

    if (mode === ConnectorMode.Orthogonal) {
      const points = path.map<IVec>((p) => [p[0], p[1]]);
      const p = Polyline.nearestPoint(points, point);
      const pl = Polyline.lenAtPoint(points, p);
      const fl = Polyline.len(points);
      return pl / fl;
    }

    const b = getBezierParameters(path);
    return getBezierNearestTime(b, point);
  }

  /**
   * Calculating the computed point along a path via a offset distance.
   *
   * Returns an absolute Surface point, not a viewport/client coordinate.
   */
  getPointByOffsetDistance(offsetDistance = 0.5, bounds?: Bound): IVec {
    const { mode, absolutePath: path } = this;

    if (mode === ConnectorMode.Straight) {
      const first = path[0];
      const last = path[path.length - 1];
      return Vec.lrp(first, last, offsetDistance);
    }

    let { x, y, w, h } = this;
    if (bounds) {
      x = bounds.x;
      y = bounds.y;
      w = bounds.w;
      h = bounds.h;
    }

    if (mode === ConnectorMode.Orthogonal) {
      const points = path.map<IVec>((p) => [p[0], p[1]]);
      const point = Polyline.pointAt(points, offsetDistance);
      if (point) return point;
      return [x + w / 2, y + h / 2];
    }

    const b = getBezierParameters(path);
    const point = getBezierPoint(b, offsetDistance);
    if (point) return point;
    return [x + w / 2, y + h / 2];
  }

  override getRelativePointLocation(point: IVec): PointLocation {
    return new PointLocation(
      Bound.deserialize(this.xywh).getRelativePoint(point),
    );
  }

  /** Resolve a measured label on an already generated Surface path without writing it. */
  getLabelXYWHOnPath(
    width: number,
    height: number,
    offset: ConnectorLabelOffsetProps = this.labelOffset,
  ): XYWH {
    const anchorOffset =
      offset.anchor === ConnectorLabelOffsetAnchor.Top
        ? -height
        : offset.anchor === ConnectorLabelOffsetAnchor.Bottom
          ? height
          : 0;
    const at = (distance: number): XYWH => {
      const [cx, cy] = this.getPointByOffsetDistance(distance);
      return [cx - width / 2, cy - height / 2 + anchorOffset, width, height];
    };
    const preferred = at(offset.distance);
    const obstacles = (this.labelObstacleIds ?? []).flatMap((id) => {
      const element = this.surface.getElementById(id);
      if (element?.type === "connector") {
        const connector = element as ConnectorElementModel,
          label = connector.labelXYWH,
          bounds = label ? [new Bound(...label)] : [];
        bounds.push(...getConnectorStrokeBounds(connector));
        return bounds;
      }
      return element?.xywh ? [Bound.deserialize(element.xywh)] : [];
    });
    for (const [id, region] of Object.entries(
      this.routingObstacleRegions ?? {},
    )) {
      const element = this.surface.getElementById(id);
      if (!element?.xywh) continue;
      const bound = Bound.deserialize(element.xywh);
      obstacles.push(
        new Bound(
          bound.x + region[0],
          bound.y + region[1],
          region[2],
          region[3],
        ),
      );
    }
    if (!obstacles.length) return preferred;
    const overlap = ([x, y, w, h]: XYWH) =>
      obstacles.reduce(
        (area, b) =>
          area +
          Math.max(0, Math.min(x + w, b.maxX) - Math.max(x, b.x)) *
            Math.max(0, Math.min(y + h, b.maxY) - Math.max(y, b.y)),
        0,
      );
    let result = preferred,
      best = overlap(preferred);
    // Keep the semantic anchor when clear. Otherwise select a nearby position
    // on the actual generated path; no free label geometry enters the source.
    for (const distance of [0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
      if (best === 0) break;
      const candidate = at(distance),
        area = overlap(candidate);
      if (area < best) {
        result = candidate;
        best = area;
      }
    }
    return result;
  }

  hasLabel() {
    return Boolean(
      !this.labelEditing &&
      this.labelDisplay &&
      this.labelXYWH &&
      this.text &&
      this.text.length,
    );
  }

  override includesPoint(
    x: number,
    y: number,
    options?: PointTestOptions | undefined,
  ): boolean {
    const currentPoint: IVec = [x, y];

    if (this.labelIncludesPoint(currentPoint as IVec)) {
      return true;
    }

    const { mode, strokeWidth, absolutePath: path } = this;

    const point =
      mode === ConnectorMode.Curve
        ? getBezierNearestPoint(getBezierParameters(path), currentPoint)
        : polyLineNearestPoint(path, currentPoint);

    if (!point) {
      return false;
    }

    return (
      Vec.dist(point, currentPoint) <
      (options?.hitThreshold ? strokeWidth / 2 : 0) + 8
    );
  }

  labelIncludesPoint(point: IVec) {
    return (
      this.hasLabel() && Bound.fromXYWH(this.labelXYWH!).isPointInBound(point)
    );
  }

  moveTo(bound: Bound) {
    const oldBound = Bound.deserialize(this.xywh);
    const offset = Vec.sub([bound.x, bound.y], [oldBound.x, oldBound.y]);
    const { source, target } = this;

    if (!source.id && source.position) {
      this.source = {
        position: Vec.add(source.position, offset) as [number, number],
      };
    }

    if (!target.id && target.position) {
      this.target = {
        position: Vec.add(target.position, offset) as [number, number],
      };
    }

    // Updates Connector's Label position.
    if (this.hasLabel()) {
      const [x, y, w, h] = this.labelXYWH!;
      this.labelXYWH = [x + offset[0], y + offset[1], w, h];
    }
  }

  resize(originalPath: PointLocation[], matrix: DOMMatrix) {
    this.updatingPath = false;

    const path = this.resizePath(originalPath, matrix);
    const props: {
      source?: Connection;
      target?: Connection;
    } = {};

    if (!this.source.id) {
      props.source = {
        ...this.source,
        position: path[0].toVec() as [number, number],
      };
    }
    if (!this.target.id) {
      props.target = {
        ...this.target,
        position: path[path.length - 1].toVec() as [number, number],
      };
    }

    return props;
  }

  resizePath(originalPath: PointLocation[], matrix: DOMMatrix) {
    if (this.mode === ConnectorMode.Curve) {
      return originalPath.map((point) => {
        const [p, t, absIn, absOut] = [
          point,
          point.tangent,
          point.absIn,
          point.absOut,
        ]
          .map((p) => new DOMPoint(...p).matrixTransform(matrix))
          .map((p) => [p.x, p.y] as IVec);
        const ip = Vec.sub(absIn, p);
        const op = Vec.sub(absOut, p);
        return new PointLocation(p, t, ip, op);
      });
    }

    return originalPath.map((point) => {
      const { x, y } = new DOMPoint(...point).matrixTransform(matrix);
      const p: IVec = [x, y];
      return PointLocation.fromVec(p);
    });
  }

  override serialize() {
    const result = super.serialize();
    result.xywh = this.xywh;
    result.source = structuredClone(this.source);
    result.target = structuredClone(this.target);
    return result as SerializedConnectorElement;
  }

  @local()
  accessor absolutePath: PointLocation[] = [];

  @field(null as number | null)
  accessor endpointScale!: number | null;

  @field("None" as PointStyle)
  accessor frontEndpointStyle!: PointStyle;

  @field(false)
  accessor frontEndpointCircle!: boolean;

  @field(false)
  accessor rearEndpointCircle!: boolean;

  /**
   * Defines the size constraints of the label.
   */
  @field({
    hasMaxWidth: true,
    maxWidth: CONNECTOR_LABEL_MAX_WIDTH,
  } as ConnectorLabelConstraintsProps)
  accessor labelConstraints!: ConnectorLabelConstraintsProps;

  /**
   * Control display and hide.
   */
  @field(true)
  accessor labelDisplay!: boolean;

  /**
   * The offset property specifies the label along the connector path.
   */
  @field({
    distance: 0.5,
    anchor: ConnectorLabelOffsetAnchor.Center,
  } as ConnectorLabelOffsetProps)
  accessor labelOffset!: ConnectorLabelOffsetProps;

  /**
   * Defines the style of the label.
   */
  @field({
    color: DefaultTheme.black,
    fontFamily: FontFamily.Inter,
    fontSize: 16,
    fontStyle: FontStyle.Normal,
    fontWeight: FontWeight.Regular,
    textAlign: TextAlign.Center,
  } as TextStyleProps)
  accessor labelStyle!: TextStyleProps;

  /**
   * Returns a `XYWH` array providing information about the size of a label
   * and its absolute position on the Surface.
   */
  @field()
  accessor labelXYWH: XYWH | undefined = undefined;

  /**
   * Local control display and hide, mainly used in editing scenarios.
   */
  @local()
  accessor labelEditing: boolean = false;

  @field()
  accessor mode: ConnectorMode = DEFAULT_CONNECTOR_MODE;

  /** Rebuilt from the owning projection; these are not document references. */
  @local()
  accessor routingObstacleIds: string[] = [];

  @local()
  accessor labelObstacleIds: string[] = [];

  @local()
  accessor routingObstacleRegions: Record<
    string,
    readonly [number, number, number, number]
  > = {};

  @local()
  accessor routingClearance: number = 0;

  @local()
  accessor routingCornerRadius: number = 0;

  @local()
  accessor routingLaneOffset: number = 0;

  @derive((path: PointLocation[], instance) => {
    const { x, y } = instance;

    return {
      absolutePath: path.map((p) => p.clone().setVec(Vec.add(p, [x, y]))),
    };
  })
  @local()
  accessor path: PointLocation[] = [];

  @field("Arrow" as PointStyle)
  accessor rearEndpointStyle!: PointStyle;

  @local()
  accessor rotate: number = 0;

  @field()
  accessor rough: boolean | undefined = undefined;

  @field()
  accessor roughness: number = DEFAULT_ROUGHNESS;

  @field()
  accessor source: Connection = {
    position: [0, 0],
  };

  @field()
  accessor stroke: Color = DefaultTheme.connectorColor;

  @field()
  accessor strokeStyle: StrokeStyle = StrokeStyle.Solid;

  @field()
  accessor strokeWidth: number = 4;

  @field()
  accessor target: Connection = {
    position: [0, 0],
  };

  /**
   * The content of the label.
   */
  @field()
  accessor text: Y.Text | undefined = undefined;

  @local()
  accessor xywh: SerializedXYWH = "[0,0,0,0]";
}

/** Actual painted stroke segments, rather than the broad interior of a loop. */
export function getConnectorStrokeBounds(
  connector: Pick<
    ConnectorElementModel,
    "absolutePath" | "mode" | "strokeWidth"
  >,
): Bound[] {
  const path = connector.absolutePath?.length
    ? connector.mode === ConnectorMode.Curve
      ? Array.from({ length: 17 }, (_, i) =>
          ConnectorElementModel.prototype.getPointByOffsetDistance.call(
            connector,
            i / 16,
          ),
        )
      : connector.absolutePath
    : [];
  const halfStroke = Math.max(1, connector.strokeWidth ?? 1) / 2;
  return path.slice(1).map((b, index) => {
    const a = path[index];
    return new Bound(
      Math.min(a[0], b[0]) - halfStroke,
      Math.min(a[1], b[1]) - halfStroke,
      Math.abs(a[0] - b[0]) + halfStroke * 2,
      Math.abs(a[1] - b[1]) + halfStroke * 2,
    );
  });
}
