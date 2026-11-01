import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  MobileSwipeMenuAction,
  MobileSwipeMenuContent,
  MobileSwipeMenuRoot,
} from "@myoxus/ui-facade";
import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";

import { HapticsService } from "../../modules/haptics";
import { SwipeHelper } from "../../utils";

export interface SwipeMenuProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> {
  menu: ReactNode;
  onExecute?: () => void;
}

const SWIPE_OPEN_TRIGGER_RATIO = 1 / 2;
const SWIPE_EXECUTE_DISTANCE_RATIO = 2;
const SWIPE_REVEAL_LIMIT_RATIO = 3;
const SWIPE_RELEASE_TRANSITION = "transform 200ms ease, width 200ms ease";

type TickFunc<T extends Array<any> = any[]> = (
  content: HTMLDivElement,
  menu: HTMLDivElement,
  options: {
    actionWidth: number;
    deltaX: number;
    animated?: boolean;
  },
  ...args: T
) => void;

function getActionWidth(menu: HTMLDivElement): number | null {
  const actionContent = menu.firstElementChild;
  if (actionContent instanceof HTMLElement) {
    const contentWidth =
      actionContent.getBoundingClientRect().width || actionContent.scrollWidth;
    if (contentWidth > 0) return contentWidth;
  }

  const menuWidth = menu.getBoundingClientRect().width || menu.scrollWidth;
  return menuWidth > 0 ? menuWidth : null;
}

function clearReleaseTransition(content: HTMLDivElement, menu: HTMLDivElement) {
  content.style.transition = "";
  menu.style.transition = "";
}

const tick: TickFunc = (content, menu, options) => {
  if (!options.animated) clearReleaseTransition(content, menu);

  const limitedDeltaX = Math.min(
    0,
    Math.max(options.deltaX, -options.actionWidth * SWIPE_REVEAL_LIMIT_RATIO),
  );
  content.style.transform = `translateX(${limitedDeltaX}px)`;
  menu.style.transform = `translateX(${limitedDeltaX}px)`;
  // Runtime px is unavoidable here: drag/reveal geometry follows the measured
  // action element width instead of a product hard-coded design value.
  menu.style.width = `${Math.max(options.actionWidth, Math.abs(limitedDeltaX))}px`;
};

const animate: TickFunc<[number]> = (content, menu, options, to) => {
  content.style.transition = SWIPE_RELEASE_TRANSITION;
  menu.style.transition = SWIPE_RELEASE_TRANSITION;
  tick(content, menu, { ...options, animated: true, deltaX: to });

  content.addEventListener(
    "transitionend",
    () => {
      clearReleaseTransition(content, menu);
    },
    {
      once: true,
    },
  );
};

const activeId$ = new LiveData<string | null>(null);

/**
 * Only support swipe left yet
 * Only support single menu item yet
 */
export const SwipeMenu = ({
  children,
  menu,
  onExecute,
  ...props
}: SwipeMenuProps) => {
  const id = useId();
  const haptics = useService(HapticsService);
  const activeId = useLiveData(activeId$);

  const isOpenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    isOpenRef.current = false;
    const content = contentRef.current;
    const menu = menuRef.current;
    if (!content || !menu) return;
    const actionWidth = getActionWidth(menu);
    if (!actionWidth) return;
    animate(content, menu, { actionWidth, deltaX: -actionWidth }, 0);
  }, []);

  useEffect(() => {
    if (activeId && activeId !== id && isOpenRef.current) {
      handleClose();
    }
  }, [activeId, handleClose, id]);

  useEffect(() => {
    const container = containerRef.current;
    const menu = menuRef.current;
    const content = contentRef.current;
    if (!container || !menu || !content) return;
    const swipeHelper = new SwipeHelper();

    let shouldExecute = false;

    return swipeHelper.init(container, {
      preventScroll: true,
      direction: "horizontal",
      onSwipeStart() {
        shouldExecute = false;
        activeId$.next(id);
      },
      onSwipe({ deltaX: dragX, initialDirection }) {
        if (initialDirection !== "horizontal") return;

        const actionWidth = getActionWidth(menu);
        if (!actionWidth) return;
        const deltaX = isOpenRef.current ? dragX - actionWidth : dragX;
        const prevShouldExecute = shouldExecute;
        shouldExecute = deltaX < -actionWidth * SWIPE_EXECUTE_DISTANCE_RATIO;
        if (shouldExecute && !prevShouldExecute) {
          haptics.impact({ style: "LIGHT" });
        }
        tick(content, menu, { actionWidth, deltaX });
      },
      onSwipeEnd({ deltaX: dragX, initialDirection }) {
        activeId$.next(null);
        if (initialDirection !== "horizontal") return;

        const actionWidth = getActionWidth(menu);
        if (!actionWidth) return;
        const deltaX = isOpenRef.current ? dragX - actionWidth : dragX;
        if (shouldExecute) {
          animate(content, menu, { actionWidth, deltaX }, 0);
          onExecute?.();
          isOpenRef.current = false;
          return;
        }
        // open
        if (deltaX < -actionWidth * SWIPE_OPEN_TRIGGER_RATIO) {
          animate(content, menu, { actionWidth, deltaX }, -actionWidth);
          isOpenRef.current = true;
        }
        // close
        else {
          animate(content, menu, { actionWidth, deltaX }, 0);
          isOpenRef.current = false;
        }
      },
    });
  }, [haptics, id, onExecute]);

  return (
    <MobileSwipeMenuRoot ref={containerRef} {...props}>
      <MobileSwipeMenuContent ref={contentRef}>
        {children}
      </MobileSwipeMenuContent>
      <MobileSwipeMenuAction ref={menuRef} onClick={handleClose}>
        {menu}
      </MobileSwipeMenuAction>
    </MobileSwipeMenuRoot>
  );
};
