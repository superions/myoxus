// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, type RefObject } from "react";
/** Consume actual horizontal intent once on the renderer plane; native vertical chaining stays owned by the document. */
export function useJourneyScroll(
  plane: RefObject<HTMLElement | null>,
  viewport: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const el = plane.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const dx = e.shiftKey
        ? e.deltaY
        : Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX
          : 0;
      if (!dx) return;
      e.preventDefault();
      e.stopPropagation();
      viewport.current?.scrollBy({ left: dx });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [plane, viewport]);
}
