import {
  MERMAID_SCOPED_GFX_PAGE_MAX_VIEWPORT_HEIGHT,
  MERMAID_SCOPED_GFX_PAGE_MIN_VIEWPORT_HEIGHT,
} from "./mermaid-block-constants.js";

export function clampMermaidVisualViewportHeight(
  height: number,
  {
    max = MERMAID_SCOPED_GFX_PAGE_MAX_VIEWPORT_HEIGHT,
    min = MERMAID_SCOPED_GFX_PAGE_MIN_VIEWPORT_HEIGHT,
  }: {
    max?: number;
    min?: number;
  } = {},
) {
  return Math.round(Math.min(max, Math.max(min, height)));
}

export function resolveMermaidVisualViewportHeight({
  autoHeight,
  storedHeight,
}: {
  autoHeight: number;
  storedHeight: unknown;
}) {
  return typeof storedHeight === "number" && Number.isFinite(storedHeight)
    ? clampMermaidVisualViewportHeight(storedHeight)
    : autoHeight;
}

export function calculateMermaidVisualViewportHeight(
  frameHeight: number,
  min: number,
  max: number,
  paddingTop: number,
  paddingBottom: number,
  minReadableZoom: number,
): number {
  return Math.round(
    Math.min(
      max,
      Math.max(min, frameHeight * minReadableZoom + paddingTop + paddingBottom),
    ),
  );
}

export function createMermaidScopedGfxFitKey({
  elementIds,
  ownerXywh,
}: {
  elementIds: readonly string[];
  ownerXywh: string;
}) {
  return `${ownerXywh}:${elementIds.join(",")}`;
}

export type MermaidScopedGfxOwnerBound = {
  h: number;
  w: number;
  x: number;
  y: number;
};

export type MermaidScopedGfxViewportController = {
  toModelCoord?: (viewX: number, viewY: number) => [number, number];
  toViewCoord?: (x: number, y: number) => [number, number];
};

export type MermaidScopedGfxViewportRect = Pick<
  DOMRect,
  "height" | "left" | "top" | "width"
>;

export function resolveMermaidPageViewportNavigationGeometry({
  contentBound,
  navigationBound,
  padding,
  scale,
  viewportRect,
}: {
  contentBound: MermaidScopedGfxOwnerBound;
  navigationBound: MermaidScopedGfxOwnerBound;
  padding: readonly [number, number, number, number];
  scale: number;
  viewportRect: Pick<MermaidScopedGfxViewportRect, "height" | "width">;
}) {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(viewportRect.width) ||
    viewportRect.width <= 0 ||
    !Number.isFinite(viewportRect.height) ||
    viewportRect.height <= 0
  ) {
    return null;
  }
  const [pt, pr, pb, pl] = padding;
  const baseWidth = (navigationBound.w + pl + pr) * scale;
  const baseHeight = (navigationBound.h + pt + pb) * scale;
  const contentCenterX =
    (contentBound.x + contentBound.w / 2 - navigationBound.x + pl) * scale;
  const contentCenterY =
    (contentBound.y + contentBound.h / 2 - navigationBound.y + pt) * scale;

  // A projection owner can contain deliberately asymmetric free layout space.
  // Add only the missing extent required to centre the real element union;
  // camera and Mantine thumb still consume this one shared geometry.
  const insetLeft = Math.max(0, viewportRect.width / 2 - contentCenterX);
  const insetTop = Math.max(0, viewportRect.height / 2 - contentCenterY);
  const insetRight = Math.max(
    0,
    viewportRect.width / 2 - (baseWidth - contentCenterX),
  );
  const insetBottom = Math.max(
    0,
    viewportRect.height / 2 - (baseHeight - contentCenterY),
  );

  return {
    contentCenterX,
    contentCenterY,
    height: baseHeight + insetTop + insetBottom,
    insetLeft,
    insetTop,
    width: baseWidth + insetLeft + insetRight,
  };
}

export function resolveMermaidPageViewportCenterPosition({
  contentBound,
  navigationBound,
  padding,
  scale,
  viewportRect,
}: {
  contentBound: MermaidScopedGfxOwnerBound;
  navigationBound: MermaidScopedGfxOwnerBound;
  padding: readonly [number, number, number, number];
  scale: number;
  viewportRect: Pick<MermaidScopedGfxViewportRect, "height" | "width">;
}) {
  const geometry = resolveMermaidPageViewportNavigationGeometry({
    contentBound,
    navigationBound,
    padding,
    scale,
    viewportRect,
  });
  if (!geometry) return null;
  const maxScrollLeft = Math.max(0, geometry.width - viewportRect.width);
  const maxScrollTop = Math.max(0, geometry.height - viewportRect.height);
  const desiredScrollLeft =
    geometry.insetLeft + geometry.contentCenterX - viewportRect.width / 2;
  const desiredScrollTop =
    geometry.insetTop + geometry.contentCenterY - viewportRect.height / 2;

  return {
    scrollLeft: Math.min(maxScrollLeft, Math.max(0, desiredScrollLeft)),
    scrollTop: Math.min(maxScrollTop, Math.max(0, desiredScrollTop)),
  };
}

export function resolveMermaidScopedViewportZoom({
  ownerBound,
  zoom,
}: {
  ownerBound: MermaidScopedGfxOwnerBound;
  zoom: number;
}) {
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  return {
    center: [
      ownerBound.x + ownerBound.w / 2,
      ownerBound.y + ownerBound.h / 2,
    ] as [number, number],
    zoom,
  };
}

export function resolveMermaidScopedPageViewportFit({
  ownerBound,
  minReadableZoom,
  padding,
  viewportRect,
}: {
  ownerBound: MermaidScopedGfxOwnerBound;
  minReadableZoom: number;
  padding: readonly [number, number, number, number];
  viewportRect: Pick<MermaidScopedGfxViewportRect, "height" | "width">;
}) {
  const [pt, pr, pb, pl] = padding;
  const availableWidth = viewportRect.width - (pr + pl);
  const availableHeight = viewportRect.height - (pt + pb);
  const fitZoom = Math.min(
    availableWidth / ownerBound.w,
    availableHeight / ownerBound.h,
  );
  const zoom =
    Number.isFinite(fitZoom) && fitZoom > 0
      ? Math.max(fitZoom, minReadableZoom)
      : minReadableZoom;
  if (!Number.isFinite(zoom) || zoom <= 0) return null;

  const visibleModelWidth = viewportRect.width / zoom;
  const visibleModelHeight = viewportRect.height / zoom;
  const fitsHorizontally =
    ownerBound.w * zoom <= viewportRect.width - (pl + pr);
  const fitsVertically = ownerBound.h * zoom <= viewportRect.height - (pt + pb);
  const centerX = fitsHorizontally
    ? ownerBound.x + (ownerBound.w + pr / zoom) / 2 - pl / zoom / 2
    : ownerBound.x + visibleModelWidth / 2 - pl / zoom;
  const centerY = fitsVertically
    ? ownerBound.y + (ownerBound.h + pb / zoom) / 2 - pt / zoom / 2
    : ownerBound.y + visibleModelHeight / 2 - pt / zoom;

  return {
    viewportX: centerX - viewportRect.width / 2 / zoom,
    viewportY: centerY - viewportRect.height / 2 / zoom,
    zoom,
  };
}

export function resolveMermaidScopedViewportFallbackPoint({
  ownerBound,
  minReadableZoom,
  padding,
  viewportRect,
  x,
  y,
}: {
  ownerBound: MermaidScopedGfxOwnerBound;
  minReadableZoom: number;
  padding: readonly [number, number, number, number];
  viewportRect: Pick<MermaidScopedGfxViewportRect, "height" | "width">;
  x: number;
  y: number;
}) {
  const fit = resolveMermaidScopedPageViewportFit({
    ownerBound,
    minReadableZoom,
    padding,
    viewportRect,
  });
  if (!fit) return null;

  return {
    left: (x - fit.viewportX) * fit.zoom,
    top: (y - fit.viewportY) * fit.zoom,
  };
}

export function resolveMermaidScopedModelFallbackPoint({
  clientX,
  clientY,
  ownerBound,
  minReadableZoom,
  padding,
  viewportRect,
}: {
  clientX: number;
  clientY: number;
  ownerBound: MermaidScopedGfxOwnerBound;
  minReadableZoom: number;
  padding: readonly [number, number, number, number];
  viewportRect: MermaidScopedGfxViewportRect;
}) {
  const fit = resolveMermaidScopedPageViewportFit({
    ownerBound,
    minReadableZoom,
    padding,
    viewportRect,
  });
  if (!fit) return null;

  return {
    x: fit.viewportX + (clientX - viewportRect.left) / fit.zoom,
    y: fit.viewportY + (clientY - viewportRect.top) / fit.zoom,
  };
}

export function resolveMermaidScopedModelPointFromClient({
  clientX,
  clientY,
  ownerBound,
  minReadableZoom,
  padding,
  viewportController,
  viewportRect,
}: {
  clientX: number;
  clientY: number;
  ownerBound: MermaidScopedGfxOwnerBound;
  minReadableZoom: number;
  padding: readonly [number, number, number, number];
  viewportController?: MermaidScopedGfxViewportController | null;
  viewportRect: MermaidScopedGfxViewportRect;
}) {
  if (viewportController?.toModelCoord) {
    const [x, y] = viewportController.toModelCoord(
      clientX - viewportRect.left,
      clientY - viewportRect.top,
    );
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  return resolveMermaidScopedModelFallbackPoint({
    clientX,
    clientY,
    ownerBound,
    minReadableZoom,
    padding,
    viewportRect,
  });
}

export function resolveMermaidScopedViewPoint({
  ownerBound,
  minReadableZoom,
  padding,
  viewportController,
  viewportRect,
  x,
  y,
}: {
  ownerBound: MermaidScopedGfxOwnerBound;
  minReadableZoom: number;
  padding: readonly [number, number, number, number];
  viewportController?: MermaidScopedGfxViewportController | null;
  viewportRect: Pick<MermaidScopedGfxViewportRect, "height" | "width">;
  x: number;
  y: number;
}) {
  if (viewportController?.toViewCoord) {
    const [left, top] = viewportController.toViewCoord(x, y);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      return { left, top };
    }
  }

  return resolveMermaidScopedViewportFallbackPoint({
    ownerBound,
    minReadableZoom,
    padding,
    viewportRect,
    x,
    y,
  });
}
