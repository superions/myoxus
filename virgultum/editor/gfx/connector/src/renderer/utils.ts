import type { RoughCanvas } from "@virgultum/block-surface";
import {
  type BezierCurveParameters,
  getBezierParameters,
  getBezierTangent,
  type IVec,
  type PointLocation,
  Vec,
} from "@virgultum/global/gfx";
import {
  type ConnectorElementModel,
  ConnectorMode,
  type LocalConnectorElementModel,
} from "@virgultum/model";

type ConnectorEnd = "Front" | "Rear";

export const DEFAULT_ARROW_SIZE = 15;

export function getArrowPoints(
  points: PointLocation[],
  size = 10,
  mode: ConnectorMode,
  bezierParameters: BezierCurveParameters,
  endPoint: ConnectorEnd = "Rear",
  radians: number = Math.PI / 4,
) {
  const anchorPoint = getPointWithTangent(
    points,
    mode,
    endPoint,
    bezierParameters,
  );
  const unit = Vec.mul(anchorPoint.tangent, -1);
  const angle = endPoint === "Front" ? Math.PI : 0;

  return {
    points: [
      Vec.add(Vec.mul(Vec.rot(unit, angle + radians), size), anchorPoint),
      anchorPoint,
      Vec.add(Vec.mul(Vec.rot(unit, angle - radians), size), anchorPoint),
    ],
  };
}

export function getCircleCenterPoint(
  points: PointLocation[],
  radius = 5,
  mode: ConnectorMode,
  bezierParameters: BezierCurveParameters,
  endPoint: ConnectorEnd = "Rear",
) {
  const anchorPoint = getPointWithTangent(
    points,
    mode,
    endPoint,
    bezierParameters,
  );

  const unit = Vec.mul(anchorPoint.tangent, -1);
  const angle = endPoint === "Front" ? Math.PI : 0;

  return Vec.add(Vec.mul(Vec.rot(unit, angle), radius), anchorPoint);
}

export function getPointWithTangent(
  points: PointLocation[],
  mode: ConnectorMode,
  endPoint: ConnectorEnd,
  bezierParameters: BezierCurveParameters,
) {
  const anchorIndex = endPoint === "Rear" ? points.length - 1 : 0;
  const pointToAnchorIndex =
    endPoint === "Rear" ? anchorIndex - 1 : anchorIndex + 1;
  const anchorPoint = points[anchorIndex];
  const pointToAnchor = points[pointToAnchorIndex];

  const clone = anchorPoint.clone();
  let tangent;
  if (mode !== ConnectorMode.Curve) {
    tangent =
      endPoint === "Rear"
        ? Vec.tangent(anchorPoint, pointToAnchor)
        : Vec.tangent(pointToAnchor, anchorPoint);
  } else {
    tangent =
      endPoint === "Rear"
        ? getBezierTangent(bezierParameters, 1)
        : getBezierTangent(bezierParameters, 0);
  }
  clone.tangent = tangent ?? [0, 0];

  return clone;
}

export function getDiamondPoints(
  point: PointLocation,
  size = 10,
  endPoint: ConnectorEnd = "Rear",
) {
  const unit = Vec.mul(point.tangent, -1);
  const angle = endPoint === "Front" ? Math.PI : 0;

  const diamondPoints = [
    Vec.add(Vec.mul(Vec.rot(unit, angle + Math.PI * 0.25), size), point),
    point,
    Vec.add(Vec.mul(Vec.rot(unit, angle - Math.PI * 0.25), size), point),
    Vec.add(Vec.mul(Vec.rot(unit, angle), size * Math.sqrt(2)), point),
  ];

  return {
    points: diamondPoints,
  };
}

export type ArrowOptions = ReturnType<typeof getArrowOptions>;

export function getArrowOptions(
  end: ConnectorEnd,
  model: ConnectorElementModel | LocalConnectorElementModel,
  strokeColor: string,
  backgroundColor: string,
) {
  const { seed, mode, rough, roughness, strokeWidth, path } = model;

  return {
    end,
    seed,
    mode,
    rough,
    roughness,
    strokeWidth,
    endpointScale: model.endpointScale ?? strokeWidth / 2,
    strokeColor,
    backgroundColor,
    fillColor: strokeColor,
    fillStyle: "solid",
    bezierParameters: getBezierParameters(path),
  };
}

export function getRcOptions(options: ArrowOptions) {
  const { seed, roughness, strokeWidth, strokeColor, fillColor } = options;
  return {
    seed,
    roughness,
    stroke: strokeColor,
    strokeWidth,
    fill: fillColor,
    fillStyle: "solid",
  };
}

export function renderRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  points: IVec[],
  color: string,
  strokeWidth: number,
  fill: boolean = true,
  close: boolean = fill,
) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.save();
  ctx.beginPath();

  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      ctx.moveTo(points[i][0], points[i][1]);
    } else {
      ctx.lineTo(points[i][0], points[i][1]);
    }
  }

  if (close) ctx.closePath();
  if (fill) ctx.fill();

  ctx.stroke();
  ctx.restore();
}

function renderHollowPolygon(
  ctx: CanvasRenderingContext2D,
  points: IVec[],
  strokeColor: string,
  backgroundColor: string,
  strokeWidth: number,
) {
  ctx.save();
  ctx.fillStyle = backgroundColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (index === 0) ctx.moveTo(point[0], point[1]);
    else ctx.lineTo(point[0], point[1]);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function renderArrow(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { mode, end, bezierParameters, rough, strokeColor, strokeWidth } =
    options;
  const radians = Math.PI / 4;
  const size = DEFAULT_ARROW_SIZE * options.endpointScale;
  const { points: arrowPoints } = getArrowPoints(
    points,
    size,
    mode,
    bezierParameters,
    end,
    radians,
  );

  if (rough) {
    rc.linearPath(arrowPoints as [number, number][], getRcOptions(options));
  } else {
    renderRoundedPolygon(ctx, arrowPoints, strokeColor, strokeWidth, false);
  }
}

export function renderTriangle(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { mode, end, bezierParameters, rough, strokeColor, strokeWidth } =
    options;
  const radians = Math.PI / 6;
  const size = DEFAULT_ARROW_SIZE * options.endpointScale;
  const { points: trianglePoints } = getArrowPoints(
    points,
    size,
    mode,
    bezierParameters,
    end,
    radians,
  );

  if (rough) {
    rc.polygon(
      [
        [trianglePoints[0][0], trianglePoints[0][1]],
        [trianglePoints[1][0], trianglePoints[1][1]],
        [trianglePoints[2][0], trianglePoints[2][1]],
      ],
      getRcOptions(options),
    );
  } else {
    renderRoundedPolygon(ctx, trianglePoints, strokeColor, strokeWidth);
  }
}

/** Half markers use the same endpoint tangent and scale as full arrows.
 * Top/bottom names refer to the connector's forward basis at either endpoint. */
export function renderHalfArrow(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
  filled: boolean,
  top: boolean,
) {
  const anchor = getPointWithTangent(
      points,
      options.mode,
      options.end,
      options.bezierParameters,
    ),
    forward = anchor.tangent,
    intoLine = Vec.mul(forward, options.end === "Rear" ? -1 : 1),
    normal = Vec.rot(forward, Math.PI / 2),
    size = DEFAULT_ARROW_SIZE * options.endpointScale,
    base = Vec.add(anchor, Vec.mul(intoLine, size * Math.cos(Math.PI / 6))),
    wing = Vec.add(
      base,
      Vec.mul(normal, size * Math.sin(Math.PI / 6) * (top ? -1 : 1)),
    ),
    vertices = (filled ? [anchor, wing, base] : [anchor, wing]) as [
      number,
      number,
    ][];
  if (options.rough) {
    if (filled) rc.polygon(vertices, getRcOptions(options));
    else rc.linearPath(vertices, getRcOptions(options));
  } else
    renderRoundedPolygon(
      ctx,
      vertices,
      options.strokeColor,
      options.strokeWidth,
      filled,
    );
}

export function renderHollowTriangle(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { mode, end, bezierParameters, rough, strokeColor, strokeWidth } =
    options;
  const radians = Math.PI / 6;
  const size = DEFAULT_ARROW_SIZE * options.endpointScale;
  const { points: trianglePoints } = getArrowPoints(
    points,
    size,
    mode,
    bezierParameters,
    end,
    radians,
  );
  if (rough) {
    rc.polygon(
      [
        [trianglePoints[0][0], trianglePoints[0][1]],
        [trianglePoints[1][0], trianglePoints[1][1]],
        [trianglePoints[2][0], trianglePoints[2][1]],
      ],
      {
        ...getRcOptions(options),
        fill: options.backgroundColor,
      },
    );
  } else {
    renderHollowPolygon(
      ctx,
      trianglePoints,
      strokeColor,
      options.backgroundColor,
      strokeWidth,
    );
  }
}

export function renderDiamond(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { mode, end, rough, bezierParameters, strokeColor, strokeWidth } =
    options;
  const anchorPoint = getPointWithTangent(points, mode, end, bezierParameters);
  const size = 10 * options.endpointScale;
  const { points: diamondPoints } = getDiamondPoints(anchorPoint, size, end);

  if (rough) {
    rc.polygon(
      [
        [diamondPoints[0][0], diamondPoints[0][1]],
        [diamondPoints[1][0], diamondPoints[1][1]],
        [diamondPoints[2][0], diamondPoints[2][1]],
        [diamondPoints[3][0], diamondPoints[3][1]],
      ],
      getRcOptions(options),
    );
  } else {
    renderRoundedPolygon(ctx, diamondPoints, strokeColor, strokeWidth);
  }
}

export function renderHollowDiamond(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { mode, end, rough, bezierParameters, strokeColor, strokeWidth } =
    options;
  const anchorPoint = getPointWithTangent(points, mode, end, bezierParameters);
  const size = 10 * options.endpointScale;
  const { points: diamondPoints } = getDiamondPoints(anchorPoint, size, end);
  if (rough) {
    rc.polygon(diamondPoints, {
      ...getRcOptions(options),
      fill: options.backgroundColor,
    });
  } else {
    renderHollowPolygon(
      ctx,
      diamondPoints,
      strokeColor,
      options.backgroundColor,
      strokeWidth,
    );
  }
}

export function renderCircle(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const {
    bezierParameters,
    mode,
    end,
    fillColor,
    strokeColor,
    strokeWidth,
    rough,
  } = options;
  const radius = 5 * options.endpointScale;
  const centerPoint = getCircleCenterPoint(
    points,
    radius,
    mode,
    bezierParameters,
    end,
  );
  const cx = centerPoint[0];
  const cy = centerPoint[1];

  if (rough) {
    // radius + 2 when render rough circle to avoid connector line cross the circle and make it looks bad
    rc.circle(cx, cy, radius + 2, getRcOptions(options));
  } else {
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius, radius, 0, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function renderHollowCircle(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { bezierParameters, mode, end, strokeColor, strokeWidth, rough } =
    options;
  const radius = 5 * options.endpointScale;
  const centerPoint = getCircleCenterPoint(
    points,
    radius,
    mode,
    bezierParameters,
    end,
  );
  if (rough) {
    rc.circle(centerPoint[0], centerPoint[1], radius + 2, {
      ...getRcOptions(options),
      fill: options.backgroundColor,
    });
  } else {
    ctx.fillStyle = options.backgroundColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(
      centerPoint[0],
      centerPoint[1],
      radius,
      radius,
      0,
      0,
      2 * Math.PI,
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** An open circle with a tangent-aligned plus; the same endpoint scale drives
 * the existing circle geometry and both strokes. */
export function renderCircleCross(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const radius = 5 * options.endpointScale;
  const center = getCircleCenterPoint(
    points,
    radius,
    options.mode,
    options.bezierParameters,
    options.end,
  );
  const { backward, normal } = getEndpointBasis(points, options);
  renderCircleAt(center, radius, ctx, rc, options, false);
  renderLineSegments(
    [
      [
        Vec.add(center, Vec.mul(backward, -radius)),
        Vec.add(center, Vec.mul(backward, radius)),
      ],
      [
        Vec.add(center, Vec.mul(normal, -radius)),
        Vec.add(center, Vec.mul(normal, radius)),
      ],
    ],
    ctx,
    rc,
    options,
  );
}

function getEndpointBasis(points: PointLocation[], options: ArrowOptions) {
  const { bezierParameters, end, mode } = options;
  const anchorPoint = getPointWithTangent(points, mode, end, bezierParameters);
  const unit = Vec.mul(anchorPoint.tangent, -1);
  const angle = end === "Front" ? Math.PI : 0;
  const backward = Vec.rot(unit, angle);
  const normal = Vec.rot(backward, Math.PI / 2);
  const size = DEFAULT_ARROW_SIZE * options.endpointScale;

  return { anchorPoint, backward, normal, size };
}

function renderLineSegments(
  segments: readonly (readonly [IVec, IVec])[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { rough, strokeColor, strokeWidth } = options;
  if (rough) {
    const rcOptions = getRcOptions(options);
    for (const [start, end] of segments) {
      rc.linearPath([start, end] as [number, number][], rcOptions);
    }
    return;
  }

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.save();
  ctx.beginPath();
  for (const [start, end] of segments) {
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(end[0], end[1]);
  }
  ctx.stroke();
  ctx.closePath();
  ctx.restore();
}

function renderCircleAt(
  center: IVec,
  radius: number,
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
  fill = true,
) {
  const { backgroundColor, fillColor, rough, strokeColor, strokeWidth } =
    options;
  if (rough) {
    rc.circle(
      center[0],
      center[1],
      radius + 2,
      fill
        ? getRcOptions(options)
        : { ...getRcOptions(options), fill: backgroundColor },
    );
    return;
  }

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(center[0], center[1], radius, radius, 0, 0, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = fill ? fillColor : backgroundColor;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function renderBar(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
    points,
    options,
  );
  const center = Vec.add(Vec.mul(backward, size * 0.35), anchorPoint);
  const half = size * 0.45;
  renderLineSegments(
    [
      [
        Vec.add(Vec.mul(normal, half), center),
        Vec.add(Vec.mul(normal, -half), center),
      ],
    ],
    ctx,
    rc,
    options,
  );
}

/** A separate exactly-one marker preserves the single Bar's other consumers. */
export function renderDoubleBar(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
      points,
      options,
    ),
    half = size * 0.45;
  const segments: [IVec, IVec][] = [0.35, 0.9].map((offset) => {
    const center = Vec.add(Vec.mul(backward, size * offset), anchorPoint);
    return [
      Vec.add(Vec.mul(normal, half), center),
      Vec.add(Vec.mul(normal, -half), center),
    ];
  });
  renderLineSegments(segments, ctx, rc, options);
}

export function renderCross(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
    points,
    options,
  );
  const center = Vec.add(Vec.mul(backward, size * 0.35), anchorPoint);
  const half = size * 0.34;
  const diagonal = Vec.add(Vec.mul(backward, half), Vec.mul(normal, half));
  const counterDiagonal = Vec.add(
    Vec.mul(backward, half),
    Vec.mul(normal, -half),
  );
  renderLineSegments(
    [
      [Vec.add(center, diagonal), Vec.add(center, Vec.mul(diagonal, -1))],
      [
        Vec.add(center, counterDiagonal),
        Vec.add(center, Vec.mul(counterDiagonal, -1)),
      ],
    ],
    ctx,
    rc,
    options,
  );
}

export function renderCrowFoot(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
    points,
    options,
  );
  // Crow's-Foot notation fans open toward the entity. Keeping the shared hub on
  // the relationship line avoids the arrowhead-like shape that appears when the
  // single point is rendered at the entity boundary.
  const toeCenter = Vec.add(Vec.mul(backward, size * 0.12), anchorPoint);
  const hub = Vec.add(Vec.mul(backward, size * 1.15), anchorPoint);
  const spread = size * 0.72;
  renderLineSegments(
    [
      [hub, Vec.add(Vec.mul(normal, spread), toeCenter)],
      [hub, toeCenter],
      [hub, Vec.add(Vec.mul(normal, -spread), toeCenter)],
    ],
    ctx,
    rc,
    options,
  );
}

export function renderCircleBar(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
    points,
    options,
  );
  renderCircleAt(
    Vec.add(Vec.mul(backward, size * 0.35), anchorPoint),
    size * 0.28,
    ctx,
    rc,
    options,
    false,
  );
  const barCenter = Vec.add(Vec.mul(backward, size * 0.9), anchorPoint);
  const half = size * 0.42;
  renderLineSegments(
    [
      [
        Vec.add(Vec.mul(normal, half), barCenter),
        Vec.add(Vec.mul(normal, -half), barCenter),
      ],
    ],
    ctx,
    rc,
    options,
  );
}

export function renderBarCrowFoot(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  renderCrowFoot(points, ctx, rc, options);
  const { anchorPoint, backward, normal, size } = getEndpointBasis(
    points,
    options,
  );
  const barCenter = Vec.add(Vec.mul(backward, size * 1.9), anchorPoint);
  const half = size * 0.42;
  renderLineSegments(
    [
      [
        Vec.add(Vec.mul(normal, half), barCenter),
        Vec.add(Vec.mul(normal, -half), barCenter),
      ],
    ],
    ctx,
    rc,
    options,
  );
}

export function renderCircleCrowFoot(
  points: PointLocation[],
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  options: ArrowOptions,
) {
  renderCrowFoot(points, ctx, rc, options);
  const { anchorPoint, backward, size } = getEndpointBasis(points, options);
  renderCircleAt(
    Vec.add(Vec.mul(backward, size * 1.95), anchorPoint),
    size * 0.28,
    ctx,
    rc,
    options,
    false,
  );
}
