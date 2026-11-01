// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type PropsWithChildren, type HTMLAttributes, forwardRef } from "react";
import { Box } from "@mantine/core";
import { joinClassName } from "./helpers/class-name";

type MobileSwipeMenuChromeProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>;

export const MobileSwipeMenuRoot = forwardRef<
  HTMLDivElement,
  MobileSwipeMenuChromeProps
>(function MobileSwipeMenuRoot(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "mobile-swipe-menu-root",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName("myoxus-mobile-swipe-menu-root", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
});

export const MobileSwipeMenuContent = forwardRef<
  HTMLDivElement,
  MobileSwipeMenuChromeProps
>(function MobileSwipeMenuContent(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "mobile-swipe-menu-content",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName("myoxus-mobile-swipe-menu-content", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
});

export const MobileSwipeMenuAction = forwardRef<
  HTMLDivElement,
  MobileSwipeMenuChromeProps
>(function MobileSwipeMenuAction(
  {
    children,
    className,
    "data-myoxus-ui-role": uiRole = "mobile-swipe-menu-action",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName("myoxus-mobile-swipe-menu-action", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
});
