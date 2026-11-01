import { Scrollable } from "@myoxus/ui-facade";
import { forwardRef, type HTMLAttributes, type PropsWithChildren } from "react";

export const SHARE_MENU_VIRTUAL_LIST_HEIGHT = `min(calc(calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs)) * 8 + var(--mantine-spacing-xl)), calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13))`;

export const Scroller = forwardRef<
  HTMLDivElement,
  PropsWithChildren<HTMLAttributes<HTMLDivElement>>
>(({ children, style, ...props }, ref) => {
  return (
    <Scrollable.Root>
      <Scrollable.VirtualizedViewport
        {...props}
        ref={ref}
        style={{
          ...style,
          height: SHARE_MENU_VIRTUAL_LIST_HEIGHT,
          maxHeight: SHARE_MENU_VIRTUAL_LIST_HEIGHT,
          minHeight: SHARE_MENU_VIRTUAL_LIST_HEIGHT,
        }}
      >
        {children}
      </Scrollable.VirtualizedViewport>
      <Scrollable.Scrollbar />
    </Scrollable.Root>
  );
});

Scroller.displayName = "Scroller";
