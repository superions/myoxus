// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Shared application viewport and main-region structure. */
import { Box } from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { forwardRef, type HTMLAttributes, type PropsWithChildren } from "react";

import { joinClassName } from "../helpers/class-name";

export function AppShellRoot({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "app-shell-root",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      bg={cssVar("backgroundPrimaryColor")}
      className={className}
      data-myoxus-ui-role={uiRole}
      display="flex"
      flex="1 1 auto"
      h={"100dvh"}
      pos="relative"
      w="100%"
      style={{ overflow: "hidden", ...props.style }}
    >
      {children}
    </Box>
  );
}

type AppContainerRoleProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>;

export function AppContainerRoot({
  children,
  className,
  noisyBackground = false,
  translucent = false,
  "data-myoxus-ui-role": uiRole = "app-container-root",
  ...props
}: AppContainerRoleProps & {
  noisyBackground?: boolean;
  translucent?: boolean;
}) {
  return (
    <AppShellRoot
      {...props}
      className={joinClassName("myoxus-app-container-root", className)}
      data-noise-background={noisyBackground ? "true" : "false"}
      data-translucent={translucent ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </AppShellRoot>
  );
}

export function AppContainerLayout({
  children,
  variant,
  "data-myoxus-ui-role": uiRole = "app-container-layout",
  ...props
}: AppContainerRoleProps & { variant: "browser" | "desktop" }) {
  return (
    <Box
      {...props}
      data-variant={variant}
      data-myoxus-ui-role={uiRole}
      display="flex"
      h="100%"
      mih={0}
      miw={0}
      pos="relative"
      w="100%"
      style={{
        flexDirection: variant === "desktop" ? "column" : "row",
        overflow: "hidden",
        ...props.style,
      }}
    >
      {children}
    </Box>
  );
}

export function AppContainerDesktopTabsHeader({
  children,
  "data-myoxus-ui-role": uiRole = "app-container-desktop-tabs-header",
  ...props
}: AppContainerRoleProps) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      display="flex"
      h={"calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"}
      w="100%"
      style={{
        flexDirection: "row",
        overflow: "hidden",
        zIndex: 1,
        ...props.style,
      }}
    >
      {children}
    </Box>
  );
}

export function AppContainerDesktopMain({
  children,
  "data-myoxus-ui-role": uiRole = "app-container-desktop-main",
  ...props
}: AppContainerRoleProps) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      display="flex"
      h={`calc(100% - calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)))`}
      mih={0}
      miw={0}
      pos="relative"
      w="100%"
      style={{
        flexDirection: "row",
        overflow: "hidden",
        ...props.style,
      }}
    >
      {children}
    </Box>
  );
}

export const AppMainRegion = forwardRef<
  HTMLDivElement,
  AppContainerRoleProps & {
    clientBorder?: boolean;
    isDesktop?: boolean;
    sideBarOpen?: boolean;
    transparent?: boolean;
  }
>(function AppMainRegion(
  {
    children,
    className,
    clientBorder = false,
    isDesktop = false,
    sideBarOpen = false,
    transparent = false,
    "data-myoxus-ui-role": uiRole = "app-main",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      bg={transparent ? "transparent" : undefined}
      className={className}
      data-client-border={!isDesktop && clientBorder ? "true" : "false"}
      data-is-desktop={isDesktop ? "true" : "false"}
      data-side-bar-open={sideBarOpen ? "true" : "false"}
      data-transparent={transparent ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      display="flex"
      flex="1 1 auto"
      maw="100%"
      mih={0}
      miw={0}
      p={!isDesktop && clientBorder ? "var(--mantine-spacing-sm)" : undefined}
      pl={!isDesktop && clientBorder && sideBarOpen ? 0 : undefined}
      pos="relative"
      w="100%"
      style={{
        borderRadius:
          !isDesktop && clientBorder ? "var(--mantine-radius-md)" : undefined,
        // AppMainRegion is a viewport boundary, not a scroll owner. Using clip
        // prevents browser focus/hover scrolling from moving the entire app;
        // nested Mantine page and widget containers own actual scrolling.
        overflow: "clip",
        zIndex: 0,
        ...props.style,
      }}
    >
      {children}
    </Box>
  );
});
