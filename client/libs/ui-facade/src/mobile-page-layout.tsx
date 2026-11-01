// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  forwardRef,
  type CSSProperties,
  type PropsWithChildren,
  type HTMLAttributes,
  type ComponentProps,
} from "react";
import {
  type RoleBoxProps,
  type FlexWrapperComponent,
} from "./helpers/ui-role";
import { SafeArea } from "./safe-area";
import { cssVar } from "@myoxus/theme";
import { Group, Box } from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import { Scrollable } from "./scrollable";

const mobilePageHeaderHeight = `calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) + var(--mantine-spacing-xs))`;

const mobilePageHeaderCenteredContentWidth = `calc(100% - (calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 2 + var(--mantine-spacing-lg)))`;

export const MobilePageHeaderRoot = forwardRef<HTMLDivElement, RoleBoxProps>(
  function MobilePageHeaderRoot(
    {
      children,
      className,
      style,
      "data-myoxus-ui-role": uiRole = "mobile-page-header",
      ...props
    },
    ref,
  ) {
    return (
      <SafeArea
        {...props}
        ref={ref}
        top
        className={className}
        data-myoxus-ui-role={uiRole}
        style={{
          backgroundColor: cssVar("backgroundSecondaryColor"),
          insetBlockStart: 0,
          insetInline: 0,
          position: "fixed",
          width: "100%",
          zIndex: 1,
          ...style,
        }}
      >
        {children}
      </SafeArea>
    );
  },
);

export function MobilePageHeaderBar({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-page-header-bar",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      component="header"
      data-myoxus-ui-role={uiRole}
      h={mobilePageHeaderHeight}
      justify="space-between"
      px={"var(--mantine-spacing-xs)"}
      style={{ position: "relative", ...style }}
    >
      {children}
    </Group>
  );
}

export function MobilePageHeaderPrefix({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-page-header-prefix",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      data-myoxus-ui-role={uiRole}
      flex={1}
      miw={0}
      style={{ flexBasis: 0, ...style }}
      w={0}
    >
      {children}
    </Group>
  );
}

export type MobilePageHeaderContentLayout = "default" | "detail";

export function MobilePageHeaderContent({
  centered = true,
  children,
  layout = "default",
  style,
  "data-myoxus-ui-role": uiRole = "mobile-page-header-content",
  ...props
}: RoleBoxProps & {
  centered?: boolean;
  /**
   * Semantic content geometry owned by the facade. Routes should select a
   * layout role instead of passing local class names for header-title width.
   */
  layout?: MobilePageHeaderContentLayout;
}) {
  return (
    <Group
      {...props}
      align="center"
      data-centered={centered ? "true" : undefined}
      data-layout={layout === "default" ? undefined : layout}
      data-myoxus-ui-role={uiRole}
      flex={centered ? undefined : 1}
      justify={centered ? "center" : undefined}
      miw={0}
      style={
        centered
          ? {
              left: "50%",
              maxWidth: mobilePageHeaderCenteredContentWidth,
              pointerEvents: "none",
              position: "absolute",
              transform: "translateX(-50%)",
              width: "fit-content",
              ...style,
            }
          : { flexBasis: 0, ...style }
      }
      w={centered ? undefined : 0}
    >
      {children}
    </Group>
  );
}

export function MobilePageHeaderSuffix({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-page-header-suffix",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      data-myoxus-ui-role={uiRole}
      flex={1}
      gap={"var(--mantine-spacing-xs)"}
      justify="flex-end"
      miw={0}
      style={{ flexBasis: 0, ...style }}
      w={0}
    >
      {children}
    </Group>
  );
}

export type MobilePageHeaderSpacerSize = "header" | "journal-date-picker";

export function MobilePageHeaderSpacer({
  height,
  size = "header",
  "data-myoxus-ui-role": uiRole = "mobile-page-header-spacer",
  ...props
}: Omit<RoleBoxProps, "children"> & {
  height?: CSSProperties["height"];
  /**
   * Semantic spacer heights stay in the facade so mobile pages do not inject
   * route-local spacing tokens for fixed header bottom content.
   */
  size?: MobilePageHeaderSpacerSize;
  "data-myoxus-ui-role"?: string;
}) {
  const resolvedHeight =
    height ??
    (size === "journal-date-picker"
      ? "calc(\n    calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) + var(--mantine-spacing-xl)\n  )"
      : mobilePageHeaderHeight);

  return (
    <Box
      {...props}
      aria-hidden="true"
      data-myoxus-ui-role={uiRole}
      data-size={size === "header" ? undefined : size}
      h={resolvedHeight}
    />
  );
}

export type MobileWorkspacePageRootProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    bounded?: boolean;
    component?: FlexWrapperComponent;
    "data-myoxus-ui-role"?: string;
    [key: `data-${string}`]: unknown;
  }
>;

export function MobileWorkspacePageRoot({
  children,
  className,
  bounded,
  component,
  style,
  ...props
}: MobileWorkspacePageRootProps) {
  const uiRole =
    props["data-myoxus-ui-role"]?.toString() ?? "mobile-workspace-page-root";
  return (
    <Box
      {...props}
      component={component}
      className={joinClassName("myoxus-mobile-workspace-page-root", className)}
      data-bounded={bounded}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Box>
  );
}

export function MobileWorkspacePageTitle({
  children,
  className,
  shown = true,
  ...props
}: MyoxusTextProps & { shown?: boolean }) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "span"}
      className={joinClassName("myoxus-mobile-workspace-page-title", className)}
      data-show={shown}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "mobile-workspace-page-title"
      }
      tone={props.tone ?? "primary"}
      truncate={props.truncate ?? true}
      typographySlot={props.typographySlot ?? "nav"}
    >
      {children}
    </MyoxusText>
  );
}

export function MobileDocInfoSheetRoot({
  className,
  ...props
}: ComponentProps<typeof Scrollable.Root>) {
  return (
    <Scrollable.Root
      {...props}
      className={className}
      data-myoxus-ui-role="mobile-doc-info-sheet-root"
      display="flex"
      flexDirection="column"
    />
  );
}

export const MobileDocInfoSheetViewport = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof Scrollable.Viewport>
>(function MobileDocInfoSheetViewport({ padding, ...props }, ref) {
  return (
    <Scrollable.Viewport
      {...props}
      ref={ref}
      data-myoxus-ui-role="mobile-doc-info-sheet-viewport"
      padding={padding ?? `0 var(--mantine-spacing-sm)`}
    />
  );
});

export function DetailPageMobileRoot({
  className,
  ...props
}: RoleBoxProps & { bounded?: boolean }) {
  return (
    <MobileWorkspacePageRoot
      {...props}
      className={joinClassName("myoxus-detail-page-mobile-root", className)}
      data-myoxus-ui-role="detail-page-mobile-root"
    />
  );
}

export function DetailPageMobileTitle({
  className,
  ...props
}: MyoxusTextProps & { shown?: boolean }) {
  return (
    <MobileWorkspacePageTitle
      {...props}
      className={joinClassName("myoxus-detail-page-mobile-title", className)}
      data-myoxus-ui-role="detail-page-mobile-title"
    />
  );
}

export function MobileJournalDatePickerFrame({
  children,
  "data-testid": testId = "mobile-journal-date-picker",
  ...props
}: RoleBoxProps & { "data-testid"?: string }) {
  return (
    <Group
      {...props}
      align="center"
      data-myoxus-ui-role="mobile-journal-date-picker"
      data-testid={testId}
      gap={"var(--mantine-spacing-xs)"}
      py={"var(--mantine-spacing-xs)"}
      px={"var(--mantine-spacing-sm)"}
      w="100%"
    >
      {children}
    </Group>
  );
}
