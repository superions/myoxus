// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import {
  Group,
  type SplitterProps,
  Splitter as MantineSplitter,
} from "@mantine/core";
import {
  type HTMLAttributes,
  forwardRef,
  type CSSProperties,
  type MouseEventHandler,
  useCallback,
} from "react";
import { joinClassName } from "./helpers/class-name";

export function SplitPane({ children, className, style }: RoleBoxProps) {
  return (
    <Group
      className={className}
      style={style}
      align="stretch"
      gap={"var(--mantine-spacing-md)"}
      wrap="nowrap"
      data-myoxus-ui-role="split-pane"
    >
      {children}
    </Group>
  );
}

type SplitViewDivProps = HTMLAttributes<HTMLDivElement> & {
  "data-myoxus-ui-role"?: string;
};

export type SplitViewOrientation = "horizontal" | "vertical";

export interface SplitViewRootProps extends SplitViewDivProps {
  clientBorder?: boolean;
  orientation?: SplitViewOrientation;
}

export const SplitViewRoot = forwardRef<HTMLDivElement, SplitViewRootProps>(
  function SplitViewRoot(
    {
      children,
      className,
      clientBorder,
      orientation = "horizontal",
      "data-myoxus-ui-role": uiRole = "split-view-root",
      ...props
    },
    ref,
  ) {
    return (
      <div
        {...props}
        ref={ref}
        className={joinClassName("myoxus-ui-split-view-root", className)}
        data-client-border={clientBorder}
        data-orientation={orientation}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </div>
    );
  },
);

export interface SplitViewPanelFrameProps extends SplitViewDivProps {
  panelOrder: number | string;
  panelSize: number | string;
  "data-is-active"?: boolean;
  "data-is-dragging"?: boolean;
  "data-is-first"?: boolean;
  "data-is-last"?: boolean;
  "data-is-reordering"?: boolean;
  "data-is-resizing"?: boolean;
}

const splitViewPanelSizeVar = "--myoxus-ui-split-view-panel-size";

const splitViewPanelOrderVar = "--myoxus-ui-split-view-panel-order";

export const SplitViewPanelFrame = forwardRef<
  HTMLDivElement,
  SplitViewPanelFrameProps
>(function SplitViewPanelFrame(
  {
    children,
    className,
    panelOrder,
    panelSize,
    style,
    "data-myoxus-ui-role": uiRole = "split-view-panel",
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={joinClassName("myoxus-ui-split-view-panel", className)}
      data-myoxus-ui-role={uiRole}
      style={{
        ...({
          [splitViewPanelSizeVar]: String(panelSize),
          [splitViewPanelOrderVar]: String(panelOrder),
        } as CSSProperties),
        ...style,
      }}
    >
      {children}
    </div>
  );
});

export const SplitViewPanelDragSurface = forwardRef<
  HTMLDivElement,
  SplitViewDivProps & { "data-is-active"?: boolean }
>(function SplitViewPanelDragSurface(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "split-view-panel-drag-surface",
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={joinClassName(
        "myoxus-ui-split-view-panel-drag-surface",
        className,
      )}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </div>
  );
});

export function SplitViewPanelContent({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "split-view-panel-content",
  ...props
}: SplitViewDivProps) {
  return (
    <div
      {...props}
      className={joinClassName("myoxus-ui-split-view-panel-content", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </div>
  );
}

export interface SplitViewResizeHandleProps extends SplitViewDivProps {
  "data-can-resize"?: boolean;
  "data-dragging-over"?: boolean;
  "data-edge": "left" | "right";
  "data-is-first"?: boolean;
  "data-is-last"?: boolean;
  "data-state": "drop-indicator" | "idle" | "resizing";
}

export const SplitViewResizeHandle = forwardRef<
  HTMLDivElement,
  SplitViewResizeHandleProps
>(function SplitViewResizeHandle(
  {
    className,
    "data-myoxus-ui-role": uiRole = "split-view-resize-handle",
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={joinClassName("myoxus-ui-split-view-resize-handle", className)}
      data-myoxus-ui-role={uiRole}
    />
  );
});

export function SplitViewFolderWarning({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "split-view-folder-warning",
  ...props
}: SplitViewDivProps) {
  return (
    <div
      {...props}
      className={joinClassName(
        "myoxus-ui-split-view-folder-warning",
        className,
      )}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </div>
  );
}

export const SplitViewIndicatorFrame = forwardRef<
  HTMLDivElement,
  SplitViewDivProps & { "data-is-dragging"?: boolean }
>(function SplitViewIndicatorFrame(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "split-view-indicator",
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={joinClassName("myoxus-ui-split-view-indicator", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </div>
  );
});

export function SplitViewIndicatorMenuAnchor({
  className,
  "data-myoxus-ui-role": uiRole = "split-view-indicator-menu-anchor",
  ...props
}: SplitViewDivProps) {
  return (
    <div
      {...props}
      className={joinClassName(
        "myoxus-ui-split-view-indicator-menu-anchor",
        className,
      )}
      data-myoxus-ui-role={uiRole}
    />
  );
}

export interface SplitViewDragHandleChromeProps extends SplitViewDivProps {
  active?: boolean;
  dragging?: boolean;
  onOpenMenu?: () => void;
  open?: boolean;
}

export const SplitViewDragHandleChrome = forwardRef<
  HTMLDivElement,
  SplitViewDragHandleChromeProps
>(function SplitViewDragHandleChrome(
  {
    active,
    className,
    dragging,
    onClick,
    onOpenMenu,
    open,
    "data-myoxus-ui-role": uiRole = "split-view-drag-handle",
    ...attrs
  },
  ref,
) {
  const handleOnClick: MouseEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!open) onOpenMenu?.();
      onClick?.(event);
    },
    [onClick, onOpenMenu, open],
  );

  return (
    <div
      {...attrs}
      ref={ref}
      data-active={active}
      data-dragging={dragging}
      data-myoxus-ui-role={uiRole}
      className={joinClassName("myoxus-ui-split-view-drag-handle", className)}
      onClick={handleOnClick}
    >
      <div
        aria-hidden="true"
        className="myoxus-ui-split-view-drag-handle-gradient"
        data-myoxus-ui-role="split-view-drag-handle-gradient"
      />
      <div
        className="myoxus-ui-split-view-drag-handle-dots"
        data-myoxus-ui-role="split-view-drag-handle-dots"
      >
        <div
          aria-hidden="true"
          data-idx={0}
          className="myoxus-ui-split-view-drag-handle-dot"
          data-myoxus-ui-role="split-view-drag-handle-dot"
        />
        <div
          aria-hidden="true"
          data-idx={1}
          className="myoxus-ui-split-view-drag-handle-dot"
          data-myoxus-ui-role="split-view-drag-handle-dot"
        />
        <div
          aria-hidden="true"
          data-idx={2}
          className="myoxus-ui-split-view-drag-handle-dot"
          data-myoxus-ui-role="split-view-drag-handle-dot"
        />
      </div>
    </div>
  );
});

/** Full-size shell split with native Mantine sizing and keyboard handles. */
export const Splitter = Object.assign(
  function Splitter({ style, ...props }: SplitterProps) {
    return (
      <MantineSplitter
        withHandle={false}
        resetOnDoubleClick={false}
        {...props}
        style={[{ width: "100%", height: "100%" }, style]}
      />
    );
  },
  { Pane: MantineSplitter.Pane },
);
