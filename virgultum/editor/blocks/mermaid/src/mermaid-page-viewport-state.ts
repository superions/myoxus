// SPDX-License-Identifier: AGPL-3.0-or-later

export const MERMAID_PAGE_FIXED_ZOOMS = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
] as const;

export type MermaidPageFixedZoom = (typeof MERMAID_PAGE_FIXED_ZOOMS)[number];
export type MermaidPageZoom = "auto" | MermaidPageFixedZoom;
export type MermaidPageViewportMode = "view" | "visual";

export type MermaidPageViewportPosition = {
  readonly scrollLeft: number;
  readonly scrollTop: number;
};

export type MermaidPageViewportNavigationGeometry = {
  readonly height: number;
  readonly insetLeft: number;
  readonly insetTop: number;
  readonly width: number;
};

export type MermaidPageZoomAnchor =
  | { readonly type: "center" }
  | {
      readonly clientX: number;
      readonly clientY: number;
      readonly type: "pointer";
    };

export type MermaidPageZoomChangeIntent = {
  readonly anchor: MermaidPageZoomAnchor;
  readonly source: "keyboard" | "select" | "wheel";
  readonly zoom: MermaidPageZoom;
};

export type MermaidPageZoomStepIntent = {
  readonly direction: -1 | 1;
  readonly type: "step";
};

export type MermaidPageViewportState = {
  readonly available: Readonly<Record<MermaidPageViewportMode, boolean>>;
  readonly centerRevisions: Readonly<Record<MermaidPageViewportMode, number>>;
  readonly positions: Readonly<
    Record<MermaidPageViewportMode, MermaidPageViewportPosition>
  >;
  readonly resolvedScales: Readonly<Record<MermaidPageViewportMode, number>>;
  readonly zoom: MermaidPageZoom;
  readonly zoomChange: {
    readonly intent: MermaidPageZoomChangeIntent;
    readonly mode: MermaidPageViewportMode;
    readonly revision: number;
  } | null;
};

export type MermaidPageViewportTransition =
  | {
      readonly available: boolean;
      readonly mode: MermaidPageViewportMode;
      readonly type: "availability";
    }
  | {
      readonly mode: MermaidPageViewportMode;
      readonly type: "center";
    }
  | {
      readonly position: MermaidPageViewportPosition;
      readonly type: "position";
      readonly mode: MermaidPageViewportMode;
    }
  | {
      readonly intent: MermaidPageZoomChangeIntent;
      readonly mode: MermaidPageViewportMode;
      readonly type: "zoom";
    }
  | {
      readonly mode: MermaidPageViewportMode;
      readonly scale: number;
      readonly type: "resolved-scale";
    };

export type MermaidPageViewportProjection = {
  /** Local previews can change navigation extents without resizing the owner. */
  readonly navigationRevision?: number;
  readonly mode: MermaidPageViewportMode;
  readonly onAvailabilityChange: (available: boolean) => void;
  readonly onPositionChange: (position: MermaidPageViewportPosition) => void;
  readonly onResolvedScaleChange: (scale: number) => void;
  readonly onZoomChange: (intent: MermaidPageZoomChangeIntent) => void;
  readonly resolveCenterPosition: () => MermaidPageViewportPosition | null;
  readonly resolveNavigationGeometry: (
    scale: number,
  ) => MermaidPageViewportNavigationGeometry | null;
  readonly state: MermaidPageViewportState;
};

const INITIAL_POSITION = Object.freeze({
  scrollLeft: 0,
  scrollTop: 0,
}) satisfies MermaidPageViewportPosition;

export function createMermaidPageViewportState(): MermaidPageViewportState {
  return {
    available: { view: false, visual: false },
    centerRevisions: { view: 0, visual: 0 },
    positions: {
      view: INITIAL_POSITION,
      visual: INITIAL_POSITION,
    },
    resolvedScales: { view: 1, visual: 1 },
    zoom: 100,
    zoomChange: null,
  };
}

export function isMermaidPageZoom(value: unknown): value is MermaidPageZoom {
  return (
    value === "auto" ||
    MERMAID_PAGE_FIXED_ZOOMS.includes(value as MermaidPageFixedZoom)
  );
}

export function resolveMermaidPageZoomScale(
  zoom: MermaidPageZoom,
  autoScale: number,
) {
  if (zoom !== "auto") return zoom / 100;
  return Number.isFinite(autoScale) && autoScale > 0 ? autoScale : 1;
}

export function resolveMermaidPageZoomStep(
  zoom: MermaidPageZoom,
  autoScale: number,
  intent: MermaidPageZoomStepIntent,
): MermaidPageFixedZoom {
  const currentPercent = resolveMermaidPageZoomScale(zoom, autoScale) * 100;
  if (intent.direction > 0) {
    return (
      MERMAID_PAGE_FIXED_ZOOMS.find((value) => value > currentPercent) ?? 150
    );
  }
  return (
    [...MERMAID_PAGE_FIXED_ZOOMS]
      .reverse()
      .find((value) => value < currentPercent) ?? 10
  );
}

function finiteScrollPosition(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function transitionMermaidPageViewportState(
  state: MermaidPageViewportState,
  transition: MermaidPageViewportTransition,
): MermaidPageViewportState {
  if (transition.type === "availability") {
    if (state.available[transition.mode] === transition.available) return state;
    return {
      ...state,
      available: {
        ...state.available,
        [transition.mode]: transition.available,
      },
    };
  }

  if (transition.type === "center") {
    if (!state.available[transition.mode]) return state;
    return {
      ...state,
      centerRevisions: {
        ...state.centerRevisions,
        [transition.mode]: state.centerRevisions[transition.mode] + 1,
      },
    };
  }

  if (transition.type === "zoom") {
    if (transition.intent.zoom === state.zoom) return state;
    return {
      ...state,
      zoom: transition.intent.zoom,
      zoomChange: {
        intent: transition.intent,
        mode: transition.mode,
        revision: (state.zoomChange?.revision ?? 0) + 1,
      },
    };
  }

  if (transition.type === "resolved-scale") {
    if (!Number.isFinite(transition.scale) || transition.scale <= 0) {
      return state;
    }
    if (state.resolvedScales[transition.mode] === transition.scale)
      return state;
    return {
      ...state,
      resolvedScales: {
        ...state.resolvedScales,
        [transition.mode]: transition.scale,
      },
    };
  }

  const position = {
    scrollLeft: finiteScrollPosition(transition.position.scrollLeft),
    scrollTop: finiteScrollPosition(transition.position.scrollTop),
  };
  const current = state.positions[transition.mode];
  if (
    current.scrollLeft === position.scrollLeft &&
    current.scrollTop === position.scrollTop
  ) {
    return state;
  }
  return {
    ...state,
    positions: {
      ...state.positions,
      [transition.mode]: position,
    },
  };
}
