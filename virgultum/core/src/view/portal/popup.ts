import { cssVar } from "@myoxus/theme";
import {
  autoUpdate,
  computePosition,
  type AutoUpdateOptions,
  type ComputePositionConfig,
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

type PortalPosition = Partial<ComputePositionConfig> & {
  referenceElement: ReferenceElement;
  autoUpdate?: true | AutoUpdateOptions;
  abortWhenRefRemoved?: boolean;
};

/** One abort signal owns the portal, its mounted controls and positioning. */
export function mountEditorPortal(
  container: HTMLElement,
  abort: AbortController,
  mount: (anchor: HTMLElement) => () => void,
  position: PortalPosition,
) {
  if (abort.signal.aborted) return null;
  const anchor = container.ownerDocument.createElement("div");
  anchor.className = "virgultum-portal";
  anchor.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
  anchor.contentEditable = "false";
  anchor.style.pointerEvents = "auto";
  container.append(anchor);
  try {
    const unmount = mount(anchor);
    const release = () => {
      try {
        unmount();
      } finally {
        anchor.remove();
      }
    };
    if (abort.signal.aborted) {
      release();
      return null;
    }
    abort.signal.addEventListener("abort", release, { once: true });
    positionPortal(anchor, abort, position);
    return anchor;
  } catch (error) {
    abort.abort();
    anchor.remove();
    throw error;
  }
}

function positionPortal(
  portalRoot: HTMLElement,
  abortController: AbortController,
  position: PortalPosition,
) {
  const visibility = portalRoot.style.visibility;
  portalRoot.style.visibility = "hidden";
  portalRoot.style.position = "absolute";
  portalRoot.style.left = "0";
  portalRoot.style.top = "0";
  portalRoot.style.zIndex = cssVar("zIndexPopover");

  const {
    referenceElement,
    autoUpdate: observe,
    abortWhenRefRemoved,
    ...options
  } = position;
  const update = () => {
    if (
      abortWhenRefRemoved !== false &&
      referenceElement instanceof Element &&
      !isElementVisible(referenceElement)
    ) {
      abortController.abort();
    }
    computePosition(referenceElement, portalRoot, {
      strategy: "absolute",
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
      })
      .catch(console.error);
  };
  if (!observe) {
    update();
  } else {
    const autoUpdateOptions = observe === true ? {} : observe;
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
}
