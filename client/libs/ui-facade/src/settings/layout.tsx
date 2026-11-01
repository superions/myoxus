// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Shared settings layout and responsive dialog structure.
 *
 * Keep route-specific data and copy outside this module. Mantine owns the
 * visual structure through the Facade; product routes only compose these roles.
 */
import {
  Box,
  Center,
  Container,
  Divider,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import {
  type ComponentProps,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import { type RoleBoxProps } from "../helpers/ui-role";
import { useResponsiveLgQuery, useResponsiveSmQuery } from "../responsive";
import { Scrollable } from "../scrollable";
import { MyoxusTitle } from "../typography";
import type { SettingsHeadingLevel } from "../typography";
import { SettingsToolbar } from "./fields";
import {
  SettingsHeadingGroup,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "./page";

/** Unframed page identity and commands; use sections for content, not titles. */
export function SettingsPageHeader({
  title,
  description,
  actions,
  "data-testid": dataTestId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Group
      component="header"
      align="center"
      justify="space-between"
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-page-header"
    >
      <Box flex={1} miw={0}>
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={1}>{title}</SettingsSectionHeading>
          {description ? (
            <SettingsSectionDescription>
              {description}
            </SettingsSectionDescription>
          ) : null}
        </SettingsHeadingGroup>
      </Box>
      {actions ? <Group>{actions}</Group> : null}
    </Group>
  );
}

/**
 * Inventory search has priority over filters and commands. Slots contain
 * domain controls; native Mantine layout owns their spacing and wrapping.
 * Filter-only rows follow the same unframed native layout.
 */
export function SettingsCollectionToolbar({
  search,
  filters,
  actions,
  "data-testid": dataTestId,
}: {
  search: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <Group
      align="center"
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-collection-toolbar"
    >
      <Box flex={1} miw={0} data-myoxus-ui-role="settings-collection-search">
        {search}
      </Box>
      {filters ? <Group>{filters}</Group> : null}
      {actions ? <Group>{actions}</Group> : null}
    </Group>
  );
}

export function SettingsDetailHeader({
  title,
  description,
  leading,
  actions,
  divider = true,
  headingLevel = 5,
  "data-testid": dataTestId,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  divider?: boolean;
  headingLevel?: SettingsHeadingLevel;
  "data-testid"?: string;
}) {
  // Detail panels need the same title/action hierarchy in Admin, Web settings
  // and future drawers. Keeping this chrome in the Facade prevents route-local
  // header CSS from drifting in color, spacing or button hierarchy.
  return (
    <Paper
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-detail-header"
      data-divider={divider ? "true" : "false"}
    >
      <Group
        align="flex-start"
        p="sm"
        wrap="wrap"
        data-myoxus-ui-role="settings-detail-header-main"
      >
        {leading}
        <Box flex={1} miw={0}>
          <SettingsHeadingGroup>
            <SettingsSectionHeading level={headingLevel} lineClamp={2}>
              {title}
            </SettingsSectionHeading>
            {description ? (
              <SettingsSectionDescription>
                {description}
              </SettingsSectionDescription>
            ) : null}
          </SettingsHeadingGroup>
        </Box>
        {actions ? (
          <Group
            justify="flex-end"
            data-myoxus-ui-role="settings-detail-header-actions"
          >
            {actions}
          </Group>
        ) : null}
      </Group>
      {divider ? <Divider /> : null}
    </Paper>
  );
}

export function SettingsFilterBar({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  // Match the unframed collection toolbar; native Group owns wrapping.
  return (
    <Group
      align="flex-end"
      className={className}
      style={style}
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-filter-bar"
    >
      {children}
    </Group>
  );
}

export function SettingsFilterField({
  children,
  label,
  htmlFor,
  className,
  style,
}: PropsWithChildren<{
  label: ReactNode;
  htmlFor?: string;
  className?: string;
  style?: CSSProperties;
}>) {
  return (
    <Stack
      className={className}
      gap={"var(--mantine-spacing-xs)"}
      style={style}
      data-myoxus-ui-role="settings-filter-field"
    >
      <Box
        component="label"
        htmlFor={htmlFor}
        style={{
          color: cssVar("textSecondaryColor"),
        }}
        data-myoxus-ui-role="settings-filter-label"
      >
        {label}
      </Box>
      {children}
    </Stack>
  );
}

export function SettingsFilterActions({
  children,
  className,
  style,
}: RoleBoxProps) {
  return (
    <SettingsToolbar
      className={className}
      justify="flex-end"
      style={{
        gridColumn: "1 / -1",
        ...style,
      }}
      data-myoxus-ui-role="settings-filter-actions"
    >
      {children}
    </SettingsToolbar>
  );
}

export function SettingsSummaryGrid({
  children,
  cols,
}: PropsWithChildren<{
  cols?: ComponentProps<typeof SimpleGrid>["cols"];
}>) {
  // Summary cards should be comparable across Admin/Web settings; callers may
  // choose Mantine-responsive column counts, but not local metric-card geometry.
  return (
    <SimpleGrid
      cols={cols ?? { base: 1, sm: 2 }}
      spacing={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      data-myoxus-ui-role="settings-summary-grid"
    >
      {children}
    </SimpleGrid>
  );
}

export function ResponsiveGrid({
  children,
  className,
  cols = { base: 1, sm: 2, lg: 3 },
  spacing = "var(--mantine-spacing-sm)",
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "responsive-grid",
}: PropsWithChildren<{
  className?: string;
  cols?: number | { base?: number; sm?: number; md?: number; lg?: number };
  spacing?: ComponentProps<typeof SimpleGrid>["spacing"];
  style?: CSSProperties;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <SimpleGrid
      className={className}
      cols={cols}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
      spacing={spacing}
      style={style}
    >
      {children}
    </SimpleGrid>
  );
}

export type SettingsMasterDetailLayoutProps = PropsWithChildren<{
  detail?: ReactNode;
  detailOpen?: boolean;
  detailPriority?: "balanced" | "detail" | "main";
  mainTestId?: string;
  detailTestId?: string;
}>;

/**
 * Settings master/detail layout for routes that should remain readable before
 * the detail pane is selected. The split ratio is product-neutral and avoids
 * per-route drawer/table hybrids.
 */
export function SettingsMasterDetailLayout({
  children,
  detail,
  detailOpen = false,
  detailPriority = "balanced",
  mainTestId,
  detailTestId,
}: SettingsMasterDetailLayoutProps) {
  const isWide = !useResponsiveLgQuery(true);
  const splitColumns = detailOpen && isWide;
  const splitTemplate =
    detailPriority === "detail"
      ? "minmax(0, 1fr) minmax(0, 2fr)"
      : detailPriority === "main"
        ? "minmax(0, 3fr) minmax(0, 2fr)"
        : "minmax(0, 2fr) minmax(0, 3fr)";

  return (
    <Box
      style={{
        alignItems: "start",
        display: "grid",
        gap: "var(--mantine-spacing-sm)",
        gridTemplateColumns: splitColumns ? splitTemplate : "minmax(0, 1fr)",
      }}
      data-myoxus-ui-role="settings-master-detail-layout"
      data-detail-priority={detailPriority}
    >
      <Box
        data-testid={mainTestId}
        data-myoxus-ui-role="settings-master-detail-main"
      >
        {children}
      </Box>
      {detailOpen ? (
        <Box
          data-testid={detailTestId}
          data-myoxus-ui-role="settings-master-detail-detail"
        >
          {detail}
        </Box>
      ) : null}
    </Box>
  );
}

export function SettingsDialogShell({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-dialog-shell",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  const isNarrow = useResponsiveSmQuery();
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        display: "flex",
        flexDirection: isNarrow ? "column" : "row",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SettingsDialogScrollRoot({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-dialog-scroll-root",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Scrollable.Root
      {...props}
      flex="1 1 auto"
      minHeight={0}
      data-myoxus-ui-role={uiRole}
      style={{
        display: "flex",
        height: "100%",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </Scrollable.Root>
  );
}

export function SettingsSidebarRoot({
  children,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "settings-sidebar",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    "data-testid"?: string;
    "data-myoxus-ui-role"?: string;
  }
>) {
  const isNarrow = useResponsiveSmQuery();
  return (
    <Stack
      {...props}
      component="aside"
      gap={"var(--mantine-spacing-md)"}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
      style={{
        background: cssVar("backgroundSecondaryColor"),
        borderBottom: isNarrow
          ? `calc(var(--mantine-scale) * 1px) solid ${cssVar("borderColor")}`
          : undefined,
        flex: "0 0 auto",
        height: isNarrow ? "auto" : "100%",
        maxHeight: isNarrow ? "242px" : undefined,
        maxWidth: isNarrow ? "100%" : "242px",
        minHeight: 0,
        overflow: "hidden",
        padding: "var(--mantine-spacing-lg)\n    var(--mantine-spacing-md)",
        width: isNarrow ? "100%" : "242px",
        ...style,
      }}
    >
      {children}
    </Stack>
  );
}

export function SettingsSidebarTitle({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-sidebar-title",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLHeadingElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <MyoxusTitle
      {...props}
      order={2}
      typographySlot="heading-small"
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </MyoxusTitle>
  );
}

export function SettingsSidebarContent({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-sidebar-content",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <ScrollArea
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        ...style,
      }}
    >
      {children}
    </ScrollArea>
  );
}

export function SettingsDialogContentCenter({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-dialog-center",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "stretch",
        display: "flex",
        flexDirection: "column",
        height: "fit-content",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export const SettingsDialogContentViewport = forwardRef<
  HTMLDivElement,
  Omit<ComponentProps<typeof Scrollable.Viewport>, "ref">
>(function SettingsDialogContentViewport(
  {
    children,
    style,
    padding,
    "data-myoxus-ui-role": uiRole = "settings-dialog",
    ...props
  },
  ref,
) {
  const isNarrow = useResponsiveSmQuery();
  const resolvedPadding = isNarrow
    ? "var(--mantine-spacing-md)"
    : (padding ??
      "var(--mantine-spacing-xl)\n    calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs)) calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))\n    calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))");
  return (
    <Scrollable.Viewport
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      padding={resolvedPadding}
      style={{
        display: "flex",
        height: "100%",
        minWidth: 0,
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Scrollable.Viewport>
  );
});

export const SettingsDialogContentPanel = forwardRef<
  HTMLDivElement,
  PropsWithChildren<{
    "data-testid"?: string;
    "data-myoxus-ui-role"?: string;
  }>
>(function SettingsDialogContentPanel(
  {
    children,
    "data-myoxus-ui-role": uiRole = "settings-dialog-content",
    "data-testid": dataTestId,
  },
  ref,
) {
  return (
    <Container
      ref={ref}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
      mb="lg"
      p={0}
      size="md"
      w="100%"
    >
      <Stack gap="md">{children}</Stack>
    </Container>
  );
});

export function SettingsDialogLoadingCenter({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-dialog-loading",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Center
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        height: "100%",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Center>
  );
}

export const SettingsSubPageTargetRoot = forwardRef<
  HTMLDivElement,
  PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
  >
>(function SettingsSubPageTargetRoot(
  {
    children,
    style,
    "data-myoxus-ui-role": uiRole = "settings-subpage-target",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      style={{
        height: "100%",
        inset: 0,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Box>
  );
});

export const SettingsSubPageMask = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>(function SettingsSubPageMask(
  { style, "data-myoxus-ui-role": uiRole = "settings-subpage-mask", ...props },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      style={{
        backgroundColor: cssVar("backgroundModalColor"),
        height: "100%",
        inset: 0,
        opacity: 0,
        pointerEvents: "none",
        position: "absolute",
        width: "100%",
        zIndex: 1,
        ...style,
      }}
    />
  );
});

export const SettingsSubPagePanel = forwardRef<
  HTMLDivElement,
  PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
  >
>(function SettingsSubPagePanel(
  {
    children,
    style,
    "data-myoxus-ui-role": uiRole = "settings-subpage-panel",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      style={{
        backgroundColor: cssVar("backgroundPrimaryColor"),
        display: "flex",
        flexDirection: "column",
        height: "100%",
        inset: 0,
        pointerEvents: "auto",
        position: "absolute",
        transform: "translateX(100%)",
        width: "100%",
        zIndex: 1,
        ...style,
      }}
    >
      {children}
    </Box>
  );
});

export function SettingsSubPageHeader({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-subpage-header",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      component="header"
      data-myoxus-ui-role={uiRole}
      style={{
        flexShrink: 0,
        padding: `var(--mantine-spacing-md) 0 var(--mantine-spacing-sm) var(--mantine-spacing-lg)`,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function SettingsSubPageScrollRoot({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "settings-subpage-scroll-root",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Scrollable.Root
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </Scrollable.Root>
  );
}

export const SettingsSubPageContentViewport = forwardRef<
  HTMLDivElement,
  Omit<ComponentProps<typeof SettingsDialogContentViewport>, "ref">
>(function SettingsSubPageContentViewport(
  {
    "data-myoxus-ui-role": uiRole = "settings-subpage-scroll-viewport",
    ...props
  },
  ref,
) {
  return (
    <SettingsDialogContentViewport
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
    />
  );
});
