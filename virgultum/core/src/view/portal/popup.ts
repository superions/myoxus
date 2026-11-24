import {
  autoUpdate,
  computePosition,
  shift,
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
