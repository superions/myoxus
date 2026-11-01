import { useLiveData, useService } from "@myoxus/infra";
import { PeekViewModalFrame, PeekViewModalOverlay } from "@myoxus/ui-facade";
import {
  createContext,
  forwardRef,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { EditorSettingService } from "../../editor-setting";
import type { PeekViewAnimation, PeekViewMode } from "../entities/peek-view";

type PeekAnimationParams = {
  opacity?: [number, number];
  duration?: number;
  easing?: string;
  onComplete?: () => void;
};

// Peek zoom interpolates measured target rectangles, which Mantine transitions
// do not model. Keep this technical geometry on the browser's native WAAPI.
const animateElement = (
  element: Element,
  keyframes: PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions,
) => element.animate(keyframes, { fill: "forwards", ...options });

function shouldKeepPeekViewOpen(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  return (
    !!el?.closest("[data-peek-view-wrapper]") ||
    // Workaround for slash-menu interactions that render outside the editor tree.
    !!el?.closest("myoxus-slash-menu")
  );
}

// a dummy context to let elements know they are inside a peek view
export const PeekViewContext = createContext<Record<string, never> | null>(
  null,
);

const emptyContext = {};

export const useInsidePeekView = () => {
  const context = useContext(PeekViewContext);
  return !!context;
};

export type PeekViewModalContainerProps = PropsWithChildren<{
  onOpenChange: (open: boolean) => void;
  open: boolean;
  target?: HTMLElement;
  controls?: React.ReactNode;
  onAnimationStart?: () => void;
  onAnimationEnd?: () => void;
  mode?: PeekViewMode;
  animation?: PeekViewAnimation;
  testId?: string;
  /** Whether to apply shadow & bg */
  dialogFrame?: boolean;
}>;

export const PeekViewModalContainer = forwardRef<
  HTMLDivElement,
  PeekViewModalContainerProps
>(function PeekViewModalContainer(
  {
    onOpenChange,
    open,
    target,
    controls,
    children,
    onAnimationStart,
    onAnimationEnd,
    animation = "fadeBottom",
    mode = "fit",
    dialogFrame = true,
  },
  ref,
) {
  const [vtOpen, setVtOpen] = useState(open);
  const [animationState, setAnimationState] = useState<"idle" | "animating">(
    "idle",
  );
  const contentClipRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const activeAnimations = useRef<Record<string, Animation | undefined>>({});
  const editorSettings = useService(EditorSettingService).editorSetting;
  const fullWidthLayout = useLiveData(
    editorSettings.settings$.selector((s) => s.fullWidthLayout),
  );
  const animateControls = useCallback((animateIn = false) => {
    const controls = controlsRef.current;
    if (!controls) return;
    animateElement(
      controls,
      {
        opacity: animateIn ? [0, 1] : [1, 0],
        transform: animateIn
          ? ["translateX(-32px)", "translateX(0)"]
          : ["translateX(0)", "translateX(-32px)"],
      },
      {
        easing: "ease-in-out",
        duration: 230,
      },
    );
  }, []);
  const animateFade = useCallback(
    (animateIn: boolean) => {
      setAnimationState("animating");
      onAnimationStart?.();
      return new Promise<void>((resolve) => {
        if (animateIn) setVtOpen(true);
        setTimeout(() => {
          const overlay = overlayRef.current;
          const contentClip = contentClipRef.current;
          if (!overlay || !contentClip) {
            resolve();
            return;
          }
          const animations = [overlay, contentClip].map((element) =>
            animateElement(
              element,
              { opacity: animateIn ? [0, 1] : [1, 0] },
              { easing: "ease-in-out", duration: 230 },
            ),
          );
          Promise.all(animations.map(({ finished }) => finished))
            .then(() => {
              if (!animateIn) setVtOpen(false);
              setAnimationState("idle");
              onAnimationEnd?.();
              resolve();
            })
            .catch(console.error);
        });
      });
    },
    [onAnimationEnd, onAnimationStart],
  );
  const zoomAnimate = useCallback(
    async (
      zoomIn?: boolean,
      paramsMap?: {
        overlay?: PeekAnimationParams;
        content?: PeekAnimationParams;
        contentWrapper?: PeekAnimationParams;
      },
    ) => {
      // If the explicit target has no bounding box, animate from the closest
      // measured ancestor. Keep it local so React's prop value remains stable.
      let animationTarget = target;
      let iteration = 0;
      while (
        animationTarget &&
        !animationTarget.getBoundingClientRect().width &&
        iteration < 10
      ) {
        animationTarget = animationTarget.parentElement || undefined;
        iteration++;
      }

      if (!animationTarget) {
        // fallback to fade animation
        return animateFade(!!zoomIn);
      }

      return new Promise<void>((resolve) => {
        const contentClip = contentClipRef.current;
        const content = contentRef.current;
        const overlay = overlayRef.current;

        if (!contentClip || !content || !animationTarget || !overlay) {
          resolve();
          setAnimationState("idle");
          onAnimationEnd?.();
          return;
        }
        const targets = contentClip;
        const lockSizeEl = content;

        const from = zoomIn ? animationTarget : contentClip;
        const to = zoomIn ? contentClip : animationTarget;

        const fromRect = from.getBoundingClientRect();
        const toRect = to.getBoundingClientRect();

        targets.style.position = "fixed";
        targets.style.opacity = "1";
        lockSizeEl.style.width = zoomIn
          ? `${toRect.width}px`
          : `${fromRect.width}px`;
        lockSizeEl.style.height = zoomIn
          ? `${toRect.height}px`
          : `${fromRect.height}px`;
        lockSizeEl.style.overflow = "hidden";
        overlay.style.pointerEvents = "none";

        activeAnimations.current.overlay?.cancel();
        activeAnimations.current.content?.cancel();
        activeAnimations.current.contentWrapper?.cancel();

        const overlayParams = paramsMap?.overlay;
        const overlayAnimation = animateElement(
          overlay,
          { opacity: overlayParams?.opacity ?? (zoomIn ? [0, 1] : [1, 0]) },
          {
            easing: overlayParams?.easing ?? "ease-in-out",
            duration: overlayParams?.duration ?? 230,
          },
        );

        const contentAnimation =
          paramsMap?.content &&
          animateElement(
            content,
            { opacity: paramsMap.content.opacity },
            {
              duration: paramsMap.content.duration ?? 230,
              easing: paramsMap.content.easing ?? "linear",
            },
          );

        const wrapperParams = paramsMap?.contentWrapper;
        const contentWrapperAnimation = animateElement(
          targets,
          {
            left: [`${fromRect.left}px`, `${toRect.left}px`],
            top: [`${fromRect.top}px`, `${toRect.top}px`],
            width: [`${fromRect.width}px`, `${toRect.width}px`],
            height: [`${fromRect.height}px`, `${toRect.height}px`],
            opacity: wrapperParams?.opacity,
          },
          {
            easing: wrapperParams?.easing ?? "ease-in-out",
            duration: wrapperParams?.duration ?? 230,
          },
        );
        contentWrapperAnimation.finished
          .then(() => {
            wrapperParams?.onComplete?.();
            setAnimationState("idle");
            onAnimationEnd?.();
            overlay.style.pointerEvents = "";
            if (zoomIn) {
              Object.assign(targets.style, {
                position: "",
                left: "",
                top: "",
                width: "",
                height: "",
              });
              Object.assign(lockSizeEl.style, {
                width: "100%",
                height: "100%",
                overflow: "",
              });
            }
            resolve();
          })
          .catch((error) => {
            if ((error as DOMException).name !== "AbortError") {
              console.error(error);
            }
          });

        activeAnimations.current = {
          overlay: overlayAnimation,
          content: contentAnimation,
          contentWrapper: contentWrapperAnimation,
        };
      });
    },
    [target, animateFade, onAnimationEnd],
  );
  /**
   * ### Animation timeline:
   * ```plain
   *                                      150ms
   *                                   ⎮ - - - - ⎮
   * dialog:     +--------400ms--------+
   * controls:               +-------230ms-------+
   *             ⎮ - - - - - ⎮
   *            controls delay =
   *             400 - 230 + 150
   * ```
   */
  const animateZoomIn = useCallback(() => {
    setAnimationState("animating");
    onAnimationStart?.();
    setVtOpen(true);
    setTimeout(() => {
      zoomAnimate(true, {
        contentWrapper: {
          opacity: [0.5, 1],
          easing: "cubic-bezier(.46,.36,0,1)",
          duration: 400,
        },
        content: {
          opacity: [0, 1],
          duration: 100,
        },
      }).catch(console.error);
    }, 0);
    setTimeout(
      () => animateControls(true),
      // controls delay: to make sure the time interval for animations of dialog and controls is 150ms.
      400 - 230 + 150,
    );
  }, [animateControls, onAnimationStart, zoomAnimate]);
  const animateZoomOut = useCallback(() => {
    setAnimationState("animating");
    onAnimationStart?.();
    animateControls(false);
    zoomAnimate(false, {
      contentWrapper: {
        easing: "cubic-bezier(.57,.25,.76,.44)",
        opacity: [1, 0.5],
        duration: 180,
      },
      content: {
        opacity: [1, 0],
        duration: 180,
        easing: "ease",
      },
    })
      .then(() => setVtOpen(false))
      .catch(console.error);
  }, [animateControls, onAnimationStart, zoomAnimate]);

  const animateFadeBottom = useCallback(
    (animateIn: boolean) => {
      setAnimationState("animating");
      return new Promise<void>((resolve) => {
        if (animateIn) setVtOpen(true);
        setTimeout(() => {
          const overlay = overlayRef.current;
          const contentClip = contentClipRef.current;
          if (!overlay || !contentClip) {
            resolve();
            return;
          }

          animateElement(
            overlay,
            { opacity: animateIn ? [0, 1] : [1, 0] },
            { easing: "ease-in-out", duration: 230 },
          );
          const contentAnimation = animateElement(
            contentClip,
            {
              opacity: animateIn ? [0, 1] : [1, 0],
              transform: animateIn
                ? ["translateY(-2%) scale(0.96)", "translateY(0) scale(1)"]
                : ["translateY(0) scale(1)", "translateY(-2%) scale(0.96)"],
            },
            {
              easing: "cubic-bezier(0.42, 0, 0.58, 1)",
              duration: 230,
            },
          );
          contentAnimation.finished
            .then(() => {
              if (!animateIn) setVtOpen(false);
              setAnimationState("idle");
              onAnimationEnd?.();
              resolve();
            })
            .catch(console.error);
        });
      });
    },
    [onAnimationEnd],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        // A native menu/popover handles its own Escape before this document
        // listener. Its event must not also dismiss the enclosing peek.
        const owner = e
          .composedPath()
          .find(
            (node) =>
              node instanceof HTMLElement &&
              node.matches('[role="dialog"], [role="menu"], [role="listbox"]'),
          );
        const dialog = contentRef.current?.closest('[role="dialog"]');
        if (owner && owner !== dialog) return;
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (animation === "zoom") {
      open ? animateZoomIn() : animateZoomOut();
    } else if (animation === "fadeBottom") {
      animateFadeBottom(open).catch(console.error);
    } else if (animation === "fade") {
      animateFade(open).catch(console.error);
    } else if (animation === "none") {
      setVtOpen(open);
    }
  }, [
    animateZoomOut,
    animation,
    open,
    target,
    animateZoomIn,
    animateFade,
    animateFadeBottom,
  ]);

  const portal =
    vtOpen && typeof document !== "undefined"
      ? createPortal(
          <>
            <PeekViewModalOverlay
              ref={overlayRef}
              animationState={animationState}
              onPointerDown={(event) => {
                if (shouldKeepPeekViewOpen(event.target)) return;
                onOpenChange(false);
              }}
            />
            <PeekViewModalFrame
              ref={ref}
              animationState={animationState}
              contentClipRef={contentClipRef}
              contentRef={contentRef}
              controls={controls}
              controlsHidden={animation === "zoom"}
              controlsRef={controlsRef}
              dialogFrame={dialogFrame}
              fullWidthLayout={fullWidthLayout}
              mobile={BUILD_CONFIG.isMobileEdition}
              mode={mode}
              data-testid="peek-view-modal"
            >
              {children}
            </PeekViewModalFrame>
          </>,
          document.body,
        )
      : null;

  return (
    <PeekViewContext.Provider value={emptyContext}>
      {portal}
    </PeekViewContext.Provider>
  );
});
