// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useDropTarget } from "./dnd";
import {
  type HTMLAttributes,
  type ReactNode,
  type CSSProperties,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  forwardRef,
} from "react";
import {
  type TooltipAlign,
  type TooltipSide,
  Tooltip,
} from "./helpers/tooltip";
import { joinClassName } from "./helpers/class-name";
import { withUnit } from "./css-utils";

export type ResizePanelHandlePosition = "left" | "right";

type ResizePanelDropTargetOptions = Parameters<typeof useDropTarget>[0];

export interface ResizeHandleProps extends HTMLAttributes<HTMLDivElement> {
  resizing: boolean;
  open: boolean;
  minWidth: number;
  maxWidth: number;
  resizeHandlePos: ResizePanelHandlePosition;
  resizeHandleOffset?: number;
  resizeHandleVerticalPadding?: number;
  onOpen: (open: boolean) => void;
  onResizing: (resizing: boolean) => void;
  onWidthChange: (width: number) => void;
  onWidthChanged?: (width: number) => void;
  tooltip?: ReactNode;
  tooltipShortcut?: string[];
  tooltipOptions?: {
    align?: TooltipAlign;
    side?: TooltipSide;
    sideOffset?: number;
    className?: string;
    style?: CSSProperties;
  };
  tooltipShortcutClassName?: string;
  dropTargetOptions?: ResizePanelDropTargetOptions;
}

export interface ResizePanelProps extends HTMLAttributes<HTMLDivElement> {
  resizing: boolean;
  open: boolean;
  minWidth: number;
  maxWidth: number;
  resizeHandlePos: ResizePanelHandlePosition;
  resizeHandleOffset?: number;
  resizeHandleVerticalPadding?: number;
  resizeHandleTooltip?: ReactNode;
  resizeHandleTooltipShortcut?: string[];
  resizeHandleTooltipShortcutClassName?: string;
  resizeHandleTooltipOptions?: ResizeHandleProps["tooltipOptions"];
  resizeHandleDropTargetOptions?: ResizePanelDropTargetOptions;
  enableAnimation?: boolean;
  width: number;
  unmountOnExit?: boolean;
  onOpen: (open: boolean) => void;
  onResizing: (resizing: boolean) => void;
  onWidthChange: (width: number) => void;
  onWidthChanged?: (width: number) => void;
}

const resizePanelWidthVar = "--myoxus-ui-resize-panel-width";

const resizeHandleOffsetVar = "--myoxus-ui-resize-handle-offset";

const resizeHandleVerticalPaddingVar =
  "--myoxus-ui-resize-handle-vertical-padding";

const resizePanelTransitionVar = "--myoxus-ui-resize-panel-transition";

const resizePanelAnimationMs = 300;

function ResizeHandle({
  className,
  resizing,
  minWidth,
  maxWidth,
  resizeHandlePos,
  resizeHandleOffset,
  resizeHandleVerticalPadding,
  dropTargetOptions,
  open,
  onOpen,
  onResizing,
  onWidthChange,
  onWidthChanged,
  tooltip,
  tooltipShortcut,
  tooltipOptions,
  style,
  ...rest
}: ResizeHandleProps) {
  // Resize geometry is pointer math, not product theme chrome. Widths remain
  // numeric here and are exposed to CSS through variables.
  const ref = useRef<HTMLDivElement>(null);
  const { dropTargetRef } = useDropTarget(dropTargetOptions, [
    dropTargetOptions,
  ]);
  const onResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      let resized = false;
      const panelContainer = ref.current?.parentElement;
      if (!panelContainer) return;
      document.body.style.cursor = "col-resize";

      const { left: anchorLeft, right: anchorRight } =
        panelContainer.getBoundingClientRect();
      let lastWidth: number | undefined;

      const onMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        const newWidth = Math.min(
          maxWidth,
          Math.max(
            resizeHandlePos === "right"
              ? moveEvent.clientX - anchorLeft
              : anchorRight - moveEvent.clientX,
            minWidth,
          ),
        );
        lastWidth = newWidth;
        resized = true;
        onWidthChange(newWidth);
        onResizing(true);
      };

      const onMouseUp = () => {
        if (!resized) onOpen(false);
        onResizing(false);
        if (lastWidth !== undefined) onWidthChanged?.(lastWidth);
        document.removeEventListener("mousemove", onMouseMove);
        document.body.style.cursor = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp, { once: true });
    },
    [
      maxWidth,
      minWidth,
      onOpen,
      onResizing,
      onWidthChange,
      onWidthChanged,
      resizeHandlePos,
    ],
  );

  return (
    <Tooltip
      content={tooltip}
      shortcut={tooltipShortcut}
      side={tooltipOptions?.side}
      align={tooltipOptions?.align}
      options={{
        className: tooltipOptions?.className,
        sideOffset: tooltipOptions?.sideOffset,
        style: tooltipOptions?.style,
      }}
    >
      <div
        {...rest}
        ref={(node) => {
          ref.current = node;
          dropTargetRef.current = node;
        }}
        className={joinClassName("myoxus-ui-resize-panel-handle", className)}
        data-testid="resize-handle"
        data-handle-position={resizeHandlePos}
        data-open={open}
        data-resizing={resizing}
        onMouseDown={onResizeStart}
        style={{
          ...({
            [resizeHandleOffsetVar]: withUnit(resizeHandleOffset ?? 0, "px"),
            [resizeHandleVerticalPaddingVar]: withUnit(
              resizeHandleVerticalPadding ?? 0,
              "px",
            ),
          } as CSSProperties),
          ...style,
        }}
      >
        <div className="myoxus-ui-resize-panel-handle-inner" />
      </div>
    </Tooltip>
  );
}

export const ResizePanel = forwardRef<HTMLDivElement, ResizePanelProps>(
  function ResizePanel(
    {
      children,
      className,
      style,
      resizing,
      minWidth,
      maxWidth,
      width,
      enableAnimation = true,
      open,
      unmountOnExit,
      onOpen,
      onResizing,
      onWidthChange,
      onWidthChanged,
      resizeHandlePos,
      resizeHandleOffset,
      resizeHandleVerticalPadding,
      resizeHandleTooltip,
      resizeHandleTooltipShortcut,
      resizeHandleTooltipShortcutClassName: _tooltipShortcutClassName,
      resizeHandleTooltipOptions,
      resizeHandleDropTargetOptions,
      ...rest
    },
    ref,
  ) {
    const domProps = { ...rest };
    const uiRole =
      (domProps as { "data-myoxus-ui-role"?: string })["data-myoxus-ui-role"] ??
      "resize-panel";
    delete (domProps as { "data-myoxus-ui-role"?: string })[
      "data-myoxus-ui-role"
    ];
    const safeWidth = Math.min(maxWidth, Math.max(minWidth, width));
    const transitionState = open ? "entered" : "exited";
    const shouldRenderChildren = open || unmountOnExit === false;

    return (
      <div
        {...domProps}
        ref={ref}
        className={joinClassName("myoxus-ui-resize-panel", className)}
        data-open={open}
        data-transition-state={transitionState}
        data-handle-position={resizeHandlePos}
        data-enable-animation={enableAnimation && !resizing}
        data-myoxus-ui-role={uiRole}
        style={{
          ...({
            [resizePanelWidthVar]: `${safeWidth}px`,
            [resizePanelTransitionVar]: `${resizePanelAnimationMs}ms`,
          } as CSSProperties),
          ...style,
        }}
      >
        <div className="myoxus-ui-resize-panel-content">
          {shouldRenderChildren ? children : null}
        </div>
        <ResizeHandle
          resizeHandlePos={resizeHandlePos}
          resizeHandleOffset={resizeHandleOffset}
          resizeHandleVerticalPadding={resizeHandleVerticalPadding}
          tooltip={resizeHandleTooltip}
          tooltipOptions={resizeHandleTooltipOptions}
          tooltipShortcut={resizeHandleTooltipShortcut}
          maxWidth={maxWidth}
          minWidth={minWidth}
          onOpen={onOpen}
          onResizing={onResizing}
          onWidthChange={onWidthChange}
          onWidthChanged={onWidthChanged}
          open={open}
          resizing={resizing}
          dropTargetOptions={resizeHandleDropTargetOptions}
        />
      </div>
    );
  },
);
