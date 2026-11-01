// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type ReactNode,
  Fragment,
  type ComponentProps,
  forwardRef,
} from "react";
import {
  Group,
  Box,
  Divider as MantineDivider,
  Paper as MantinePaper,
} from "@mantine/core";
import { type ToolbarSurfaceProps, ToolbarSurface } from "../toolbar-surface";
import { useResponsiveSmQuery } from "../responsive";
import { type MyoxusTitleProps, MyoxusTitle, MyoxusText } from "../typography";
import { type MyoxusIconButtonProps, IconButton } from "../button";
import { joinClassName } from "../helpers/class-name";
import { cssVar } from "@myoxus/theme";

export function HeaderActionGroup({
  children,
  "data-myoxus-ui-role": uiRole = "header-action-group",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Group {...props} data-myoxus-ui-role={uiRole} gap="xs" wrap="nowrap">
      {children}
    </Group>
  );
}

export function HeaderActionBar({
  children,
  compact: _compact,
  "data-myoxus-ui-role": uiRole = "header-action-bar",
  ...props
}: Omit<ToolbarSurfaceProps, "compact"> & { compact?: never }) {
  const isNarrow = useResponsiveSmQuery();

  return (
    <ToolbarSurface
      {...props}
      compact={isNarrow}
      data-narrow={isNarrow ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </ToolbarSurface>
  );
}

export function WorkbenchHeaderTitle({
  children,
  className,
  lineClamp,
  "data-myoxus-ui-role": uiRole = "workbench-header-title",
  ...props
}: MyoxusTitleProps & { "data-myoxus-ui-role"?: string }) {
  return (
    <MyoxusTitle
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      lineClamp={lineClamp ?? 1}
      order={props.order ?? 3}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "body"}
      fallbackSlot={props.fallbackSlot ?? "body"}
      m={0}
      miw={0}
      ta={props.ta ?? "center"}
    >
      {children}
    </MyoxusTitle>
  );
}

export function WorkbenchHeaderContextPath({
  current,
  parents = [],
  "data-myoxus-ui-role": uiRole = "workbench-header-context-path",
}: {
  current: ReactNode;
  parents?: ReactNode[];
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Group
      data-myoxus-ui-role={uiRole}
      gap="xs"
      justify="center"
      miw={0}
      w="100%"
      wrap="nowrap"
    >
      {parents.map((parent, index) => (
        <Fragment key={index}>
          <MyoxusText
            component="span"
            flexShrink={1}
            minWidth={0}
            tone="secondary"
            truncate
            typographySlot="body-small"
          >
            {parent}
          </MyoxusText>
          <MyoxusText
            component="span"
            tone="secondary"
            typographySlot="body-small"
          >
            /
          </MyoxusText>
        </Fragment>
      ))}
      <MyoxusText
        component="h3"
        flexShrink={1}
        minWidth={0}
        tone="secondary"
        truncate
        typographySlot="body"
      >
        {current}
      </MyoxusText>
    </Group>
  );
}

type HeaderActionPriority = "always" | "wide";

function shouldRenderHeaderActionPriority(
  priority: HeaderActionPriority,
  isNarrow: boolean,
) {
  return priority !== "wide" || !isNarrow;
}

export function HeaderActionPrioritySlot({
  children,
  priority = "always",
  "data-myoxus-ui-role": uiRole = "header-action-priority-slot",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & {
    priority?: HeaderActionPriority;
    "data-myoxus-ui-role"?: string;
  }
>) {
  // Product code declares action priority only. The Facade owns the Mantine
  // breakpoint read so route modules never branch on viewport state.
  const isNarrow = useResponsiveSmQuery();
  if (!shouldRenderHeaderActionPriority(priority, isNarrow)) return null;

  return (
    <Group
      {...props}
      component="span"
      data-priority={priority}
      data-myoxus-ui-role={uiRole}
      gap={0}
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function HeaderActionResponsiveLabel({
  wide,
  narrow,
  "data-myoxus-ui-role": uiRole = "header-action-responsive-label",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  wide: ReactNode;
  narrow?: ReactNode;
  "data-myoxus-ui-role"?: string;
}) {
  const isNarrow = useResponsiveSmQuery();
  return (
    <Box {...props} component="span" data-myoxus-ui-role={uiRole}>
      {isNarrow && narrow !== undefined ? narrow : wide}
    </Box>
  );
}

export function HeaderActionDivider({
  priority = "always",
  "data-myoxus-ui-role": uiRole = "header-action-divider",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  priority?: HeaderActionPriority;
  "data-myoxus-ui-role"?: string;
}) {
  const isNarrow = useResponsiveSmQuery();
  if (!shouldRenderHeaderActionPriority(priority, isNarrow)) return null;

  return (
    <MantineDivider
      {...(props as ComponentProps<typeof MantineDivider>)}
      orientation="vertical"
      aria-hidden="true"
      data-priority={priority}
      data-myoxus-ui-role={uiRole}
    />
  );
}

export const HeaderActionAvatarButton = forwardRef<
  HTMLButtonElement,
  PropsWithChildren<MyoxusIconButtonProps>
>(function HeaderActionAvatarButton(
  {
    children,
    size = "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
    variant = "plain",
    withoutHover = true,
    "data-myoxus-ui-role": uiRole = "header-action-avatar-button",
    ...props
  },
  ref,
) {
  return (
    <IconButton
      {...props}
      ref={ref}
      size={size}
      variant={variant}
      withoutHover={withoutHover}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </IconButton>
  );
});

export const WorkbenchContextPanelToggleButton = forwardRef<
  HTMLButtonElement,
  PropsWithChildren<MyoxusIconButtonProps & { show?: boolean }>
>(function WorkbenchContextPanelToggleButton(
  { className, show = true, children, "data-myoxus-ui-role": uiRole, ...props },
  ref,
) {
  if (!show) return null;
  return (
    <IconButton
      {...props}
      ref={ref}
      className={className}
      data-myoxus-ui-role={uiRole ?? "workbench-context-panel-toggle"}
    >
      {children}
    </IconButton>
  );
});

type WorkbenchDocumentHeaderProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>;

export const WorkbenchDocumentHeaderRoot = forwardRef<
  HTMLDivElement,
  WorkbenchDocumentHeaderProps & { dragging?: boolean }
>(function WorkbenchDocumentHeaderRoot(
  {
    children,
    className,
    dragging = false,
    "data-myoxus-ui-role": uiRole = "workbench-document-header-root",
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(
        "myoxus-workbench-document-header-root",
        className,
      )}
      data-dragging={dragging ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      h="100%"
      pos="relative"
      w="100%"
    >
      {children}
    </Box>
  );
});

export function WorkbenchDocumentHeaderDragPreview({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "workbench-document-header-drag-preview",
  ...props
}: WorkbenchDocumentHeaderProps) {
  return (
    <MantinePaper
      {...props}
      bg={cssVar("backgroundPrimaryColor")}
      className={className}
      data-myoxus-ui-role={uiRole}
      maw={`min(100%, 56rem)`}
      px="xs"
      py={"var(--mantine-spacing-2xs)"}
      radius="xl"
      withBorder
    >
      {children}
    </MantinePaper>
  );
}
