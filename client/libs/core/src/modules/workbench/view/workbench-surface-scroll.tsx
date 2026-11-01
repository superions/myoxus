// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  type PropsWithChildren,
  type RefObject,
  useContext,
} from "react";

type WorkbenchSurfaceScrollViewportRef = RefObject<HTMLDivElement | null>;

const WorkbenchSurfaceScrollContext =
  createContext<WorkbenchSurfaceScrollViewportRef | null>(null);

/** Shares the one route-level scrolling viewport with editor integrations. */
export function WorkbenchSurfaceScrollProvider({
  children,
  viewportRef,
}: PropsWithChildren<{ viewportRef: WorkbenchSurfaceScrollViewportRef }>) {
  return (
    <WorkbenchSurfaceScrollContext.Provider value={viewportRef}>
      {children}
    </WorkbenchSurfaceScrollContext.Provider>
  );
}

/**
 * Returns the actual Mantine ScrollArea viewport owned by RouteContainer.
 * Editors bind selection and scroll-sensitive behavior to this node rather
 * than creating a second page scroller inside the Workbench surface.
 */
export function useWorkbenchSurfaceScrollViewport() {
  const viewportRef = useContext(WorkbenchSurfaceScrollContext);
  if (!viewportRef) {
    throw new Error(
      "useWorkbenchSurfaceScrollViewport must be used inside RouteContainer",
    );
  }
  return viewportRef;
}
