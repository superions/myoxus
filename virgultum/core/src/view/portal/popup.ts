import { cssVar } from "@myoxus/theme";
import type { AdvancedPortalOptions } from "./types";
import {
  autoUpdate,
  computePosition,
  shift,
  type ComputePositionReturn,
  type Middleware,
  type Placement,
  type ReferenceElement,
} from "@floating-ui/dom";
import { editorHostSelector } from "../../runtime/view/element/document-host.js";
import { RANGE_SYNC_EXCLUDE_ATTR } from "../../runtime/inline/index";

export const getDefaultModalRoot = (ele: HTMLElement) => {
  const host = ele.closest<HTMLElement>(editorHostSelector);
  if (host) {
    return host;
  }
  return document.body;
};
export const createModal = (container: HTMLElement = document.body) => {
  const div = document.createElement("div");
  div.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
  div.style.pointerEvents = "auto";
  div.style.position = "absolute";
  div.style.left = "0";
  div.style.top = "0";
  div.style.width = "100%";
  div.style.height = "100%";
  div.style.zIndex = "1001";
  div.style.fontFamily = "var(--myoxus-font-family)";
  container.append(div);
  return div;
};
export type PopupTarget = {
  targetRect: ReferenceElement;
  root: HTMLElement;
  popupStart: () => () => void;
};
export const popupTargetFromElement = (element: HTMLElement): PopupTarget => {
  let rect = element.getBoundingClientRect();
  let count = 0;
  let isActive = false;
  return {
    targetRect: {
      contextElement: element,
      getBoundingClientRect: () => {
        if (element.isConnected) {
          return (rect = element.getBoundingClientRect());
        }
        return rect;
      },
    },
    root: getDefaultModalRoot(element),
    popupStart: () => {
      if (!count) {
        isActive = element.classList.contains("active");
        if (!isActive) {
          element.classList.add("active");
        }
      }
      count++;
      return () => {
        count--;
        if (!count && !isActive) {
          element.classList.remove("active");
        }
      };
    },
  };
};
export const createPopup = (
  target: PopupTarget,
  content: HTMLElement,
  options?: {
    onClose?: () => void;
    middleware?: Array<Middleware | null | undefined | false>;
    container?: HTMLElement;
    placement?: Placement;
  },
) => {
  const close = () => {
    modal.remove();
    options?.onClose?.();
  };
  const modal = createModal(target.root);
  autoUpdate(target.targetRect, content, () => {
    computePosition(target.targetRect, content, {
      placement: options?.placement,
      middleware: options?.middleware ?? [shift({ crossAxis: true })],
    })
      .then(({ x, y }) => {
        Object.assign(content.style, {
          left: `${x}px`,
          top: `${y}px`,
        });
      })
      .catch(console.error);
  });
  modal.append(content);

  modal.onpointerdown = (ev) => {
    if (ev.target === modal) {
      close();
    }
  };

  modal.onmousedown = (ev) => {
    if (ev.target === modal) {
      close();
    }
  };

  modal.oncontextmenu = (ev) => {
    ev.preventDefault();
    if (ev.target === modal) {
      close();
    }
  };

  return close;
};

/**
 * Where el is the DOM element you'd like to test for visibility
 */
function isElementVisible(el: Element) {
  // The API is not stable, so we need to check the existence of the function first
  // See also https://caniuse.com/?search=checkVisibility
  if (el.checkVisibility) {
    // See https://drafts.csswg.org/cssom-view-1/#dom-element-checkvisibility
    return el.checkVisibility();
  }
  // Fallback to the old way
  // Remove this when the `checkVisibility` API is stable
  if (!el.isConnected) return false;

  if (el instanceof HTMLElement) {
    // See https://stackoverflow.com/questions/19669786/check-if-element-is-visible-in-dom
    return !(el.offsetParent === null);
  }
  return true;
}

/** Anchor either native or template content using the same editor geometry. */
export function positionPortal(
  portalRoot: HTMLDivElement,
  abortController: AbortController,
  positionConfigOrFn: AdvancedPortalOptions["computePosition"],
  positionStrategy: "absolute" | "fixed" = "absolute",
  portalStyles?: AdvancedPortalOptions["portalStyles"],
  onPosition?: (position: ComputePositionReturn) => void,
) {
  if (!positionConfigOrFn) {
    return { portal: portalRoot, update: () => {} };
  }

  const visibility = portalRoot.style.visibility;
  portalRoot.style.visibility = "hidden";
  portalRoot.style.position = positionStrategy;
  portalRoot.style.left = "0";
  portalRoot.style.top = "0";
  portalRoot.style.zIndex = cssVar("zIndexPopover");

  Object.assign(portalRoot.style, portalStyles);

  const computePositionOptions =
    positionConfigOrFn instanceof Function
      ? positionConfigOrFn(portalRoot)
      : positionConfigOrFn;
  const { referenceElement, ...options } = computePositionOptions;
  const update = () => {
    if (
      computePositionOptions.abortWhenRefRemoved !== false &&
      referenceElement instanceof Element &&
      !isElementVisible(referenceElement)
    ) {
      abortController.abort();
    }
    computePosition(referenceElement, portalRoot, {
      strategy: positionStrategy,
      ...options,
    })
      .then((positionReturn) => {
        const { x, y } = positionReturn;
        // Use transform maybe cause overlay-mask offset issue
        // portalRoot.style.transform = `translate(${x}px, ${y}px)`;
        portalRoot.style.left = `${x}px`;
        portalRoot.style.top = `${y}px`;
        if (portalRoot.style.visibility === "hidden") {
          portalRoot.style.visibility = visibility;
        }
        if (!abortController.signal.aborted) onPosition?.(positionReturn);
      })
      .catch(console.error);
  };
  if (!computePositionOptions.autoUpdate) {
    update();
  } else {
    const autoUpdateOptions =
      computePositionOptions.autoUpdate === true
        ? {}
        : computePositionOptions.autoUpdate;
    const cleanup = autoUpdate(
      referenceElement,
      portalRoot,
      update,
      autoUpdateOptions,
    );
    abortController.signal.addEventListener("abort", () => {
      cleanup();
    });
  }

  return { portal: portalRoot, update };
}
