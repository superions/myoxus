import { createIdentifier } from "@virgultum/global/di";
import { VirgultumError } from "@virgultum/global/exceptions";
import { StdIdentifier } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";

import type { Viewport } from "../types";

export interface ViewportElementService {
  get viewportElement(): HTMLElement;
  get viewport(): Viewport;
}

export const ViewportElementProvider = createIdentifier<ViewportElementService>(
  "ViewportElementProvider",
);

export const ViewportElementExtension = (selector: string): ExtensionType => {
  return {
    setup: (di) => {
      di.override(ViewportElementProvider, (provider) => {
        const getViewportElement = (): HTMLElement => {
          const std = provider.get(StdIdentifier);
          const viewportElement = std.host.closest<HTMLElement>(selector);
          if (!viewportElement) {
            throw new VirgultumError(
              VirgultumError.ErrorCode.ValueNotExists,
              `ViewportElementProvider: viewport element is not found`,
            );
          }
          return viewportElement;
        };
        return {
          get viewportElement() {
            return getViewportElement();
          },
          get viewport() {
            const viewportElement = getViewportElement();
            const {
              scrollLeft,
              scrollTop,
              scrollWidth,
              scrollHeight,
              clientWidth,
              clientHeight,
            } = viewportElement;
            const { top, left } = viewportElement.getBoundingClientRect();
            return {
              top,
              left,
              scrollLeft,
              scrollTop,
              scrollWidth,
              scrollHeight,
              clientWidth,
              clientHeight,
            };
          },
        };
      });
    },
  };
};
