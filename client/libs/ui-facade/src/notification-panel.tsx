// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type ComponentProps,
  type ReactNode,
  forwardRef,
  type KeyboardEventHandler,
} from "react";
import {
  Box,
  Card as MantineCard,
  Divider as MantineDivider,
  Group,
  List as MantineList,
  Center,
  Stack,
  ThemeIcon as MantineThemeIcon,
} from "@mantine/core";
import {
  type MyoxusTextProps,
  MyoxusText,
  type MyoxusTitleProps,
  MyoxusTitle,
} from "./typography";
import { Scrollable } from "./scrollable";
import { type MyoxusIconButtonProps, IconButton } from "./button";
import { Skeleton } from "./feedback";

export function NotificationPanelRoot({
  children,
  className,
  mode = "preview",
  mobile = false,
  style,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    mode?: "embedded" | "preview" | "route";
    mobile?: boolean;
  }
>) {
  const isRoute = mode === "route";
  if (mode === "embedded") {
    return (
      <Box
        {...props}
        component="section"
        className={className}
        w="100%"
        style={style}
        data-mode={mode}
        data-myoxus-ui-role="notification-panel"
      >
        {children}
      </Box>
    );
  }
  return (
    <MantineCard
      {...props}
      component="section"
      className={className}
      mah={isRoute ? undefined : "448px"}
      p={0}
      w={mobile || isRoute ? "100%" : "360px"}
      withBorder={!isRoute}
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        ...style,
      }}
      data-mobile={mobile ? "true" : undefined}
      data-mode={mode}
      data-myoxus-ui-role="notification-panel"
    >
      {children}
    </MantineCard>
  );
}

export function NotificationPanelFooter({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <>
      <MantineDivider />
      <Group
        {...props}
        component="footer"
        className={className}
        justify="flex-end"
        px="md"
        py="sm"
        data-myoxus-ui-role="notification-panel-footer"
      >
        {children}
      </Group>
    </>
  );
}

export function NotificationPanelHeader({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <>
      <Group
        {...props}
        component="header"
        className={className}
        justify="space-between"
        px="md"
        py="sm"
        wrap="nowrap"
        data-myoxus-ui-role="notification-panel-header"
      >
        {children}
      </Group>
      <MantineDivider />
    </>
  );
}

export function NotificationPanelHeaderTitle({
  children,
  className,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "span"}
      className={className}
      tone={props.tone ?? "primary"}
      typographySlot={props.typographySlot ?? "nav"}
      data-myoxus-ui-role="notification-panel-header-title"
    >
      {children}
    </MyoxusText>
  );
}

export function NotificationPanelScrollRoot({
  className,
  ...props
}: ComponentProps<typeof Scrollable.Root>) {
  return (
    <Scrollable.Root
      {...props}
      className={className}
      display="flex"
      flex="1 1 auto"
      flexDirection="column"
      minHeight={0}
      data-myoxus-ui-role="notification-panel-scroll-root"
    />
  );
}

export function NotificationPanelViewport({
  className,
  ...props
}: ComponentProps<typeof Scrollable.Viewport>) {
  return (
    <Scrollable.Viewport
      {...props}
      className={className}
      fill
      padding={`var(--mantine-spacing-sm) 0`}
      data-myoxus-ui-role="notification-panel-viewport"
    />
  );
}

export function NotificationPanelList({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLUListElement>>) {
  return (
    <MantineList
      {...props}
      className={className}
      listStyleType="none"
      spacing="sm"
      withPadding={false}
      data-myoxus-ui-role="notification-panel-list"
    >
      {children}
    </MantineList>
  );
}

export function NotificationPanelGroupTitle({
  children,
  className,
  ...props
}: MyoxusTitleProps) {
  return (
    <MyoxusTitle
      {...props}
      order={props.order ?? 3}
      className={className}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "nav"}
      data-myoxus-ui-role="notification-panel-group-title"
    >
      {children}
    </MyoxusTitle>
  );
}

export function NotificationPanelEmpty({
  description,
  icon,
  title,
}: {
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <Center
      mih={"184px"}
      px="xl"
      py="xl"
      data-myoxus-ui-role="notification-panel-empty"
    >
      <Stack align="center" gap="xs">
        {icon ? (
          <MantineThemeIcon
            color="myoxus"
            radius="xl"
            size="lg"
            variant="light"
            data-myoxus-ui-role="notification-panel-empty-icon"
          >
            {icon}
          </MantineThemeIcon>
        ) : null}
        <MyoxusText
          component="div"
          textAlign="center"
          tone="primary"
          typographySlot="nav"
          data-myoxus-ui-role="notification-panel-empty-title"
        >
          {title}
        </MyoxusText>
        {description ? (
          <MyoxusText
            component="div"
            textAlign="center"
            tone="secondary"
            typographySlot="body-small"
            data-myoxus-ui-role="notification-panel-empty-description"
          >
            {description}
          </MyoxusText>
        ) : null}
      </Stack>
    </Center>
  );
}

export function NotificationPanelError({
  children,
  className,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      className={className}
      tone={props.tone ?? "danger"}
      typographySlot={props.typographySlot ?? "nav"}
      data-myoxus-ui-role="notification-panel-error"
    >
      {children}
    </MyoxusText>
  );
}

export type NotificationPanelItemProps = HTMLAttributes<HTMLDivElement> & {
  disabled?: boolean;
  footer?: ReactNode;
  interactive?: boolean;
  skeleton?: boolean;
};

export const NotificationPanelItem = forwardRef<
  HTMLDivElement,
  NotificationPanelItemProps
>(function NotificationPanelItem(
  {
    children,
    className,
    disabled = false,
    footer,
    interactive,
    onClick,
    onKeyDown,
    role,
    skeleton = false,
    tabIndex,
    ...props
  },
  ref,
) {
  const isInteractive = interactive ?? Boolean(onClick);
  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled || !isInteractive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  return (
    <MantineCard
      {...props}
      ref={ref}
      component="div"
      className={className}
      p="sm"
      role={role ?? (isInteractive ? "button" : undefined)}
      tabIndex={tabIndex ?? (isInteractive && !disabled ? 0 : undefined)}
      withBorder={false}
      data-disabled={disabled ? "true" : undefined}
      data-interactive={isInteractive && !disabled ? "true" : undefined}
      data-skeleton={skeleton ? "true" : undefined}
      data-myoxus-ui-role="notification-panel-item"
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
    >
      <Group align="flex-start" gap="sm" wrap="nowrap">
        {children}
      </Group>
      {footer}
    </MantineCard>
  );
});

export function NotificationPanelLeadingIcon({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>) {
  return (
    <MantineThemeIcon
      {...props}
      component="span"
      className={className}
      color="myoxus"
      radius="xl"
      size="lg"
      variant="subtle"
      data-myoxus-ui-role="notification-panel-leading-icon"
    >
      {children}
    </MantineThemeIcon>
  );
}

export function NotificationPanelItemMain({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Stack
      {...props}
      className={className}
      flex="1 1 auto"
      gap="xs"
      miw={0}
      data-myoxus-ui-role="notification-panel-item-main"
    >
      {children}
    </Stack>
  );
}

export function NotificationPanelItemMessage({
  children,
  className,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "span"}
      className={className}
      tone={props.tone ?? "primary"}
      typographySlot={props.typographySlot ?? "nav"}
      data-myoxus-ui-role="notification-panel-item-message"
    >
      {children}
    </MyoxusText>
  );
}

export function NotificationPanelItemDate({
  children,
  className,
  ...props
}: MyoxusTextProps) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      className={className}
      tone={props.tone ?? "secondary"}
      typographySlot={props.typographySlot ?? "body-small"}
      data-myoxus-ui-role="notification-panel-item-date"
    >
      {children}
    </MyoxusText>
  );
}

export function NotificationPanelEntity({
  children,
  className,
  inactive = false,
  ...props
}: MyoxusTextProps & { inactive?: boolean }) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "strong"}
      className={className}
      data-inactive={inactive ? "true" : undefined}
      tone={inactive ? "muted" : (props.tone ?? "primary")}
      typographySlot={props.typographySlot ?? "nav"}
      data-myoxus-ui-role="notification-panel-entity"
    >
      {children}
    </MyoxusText>
  );
}

export function NotificationPanelEntityIcon({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLSpanElement>>) {
  return (
    <MantineThemeIcon
      {...props}
      component="span"
      className={className}
      color="myoxus"
      mr="xs"
      size="xs"
      variant="transparent"
      data-myoxus-ui-role="notification-panel-entity-icon"
    >
      {children}
    </MantineThemeIcon>
  );
}

export function NotificationPanelDeleteAction({
  className,
  ...props
}: MyoxusIconButtonProps) {
  return (
    <IconButton
      {...props}
      className={className}
      variant={props.variant ?? "plain"}
      data-myoxus-ui-role="button:notification-panel-delete"
    />
  );
}

/** Semantic action for acknowledging an unread notification. */
export function NotificationPanelReadAction({
  className,
  ...props
}: MyoxusIconButtonProps) {
  return (
    <IconButton
      {...props}
      className={className}
      variant={props.variant ?? "plain"}
      data-myoxus-ui-role="button:notification-panel-read"
    />
  );
}

export const NotificationPanelLoadMoreIndicator = forwardRef<
  HTMLDivElement,
  MyoxusTextProps
>(function NotificationPanelLoadMoreIndicator(
  { children, className, ...props },
  ref,
) {
  return (
    <Center
      ref={ref}
      className={className}
      h={"var(--mantine-spacing-xl)"}
      data-myoxus-ui-role="notification-panel-load-more"
    >
      <MyoxusText
        {...props}
        component={props.component ?? "span"}
        tone={props.tone ?? "secondary"}
        typographySlot={props.typographySlot ?? "body-small"}
      >
        {children}
      </MyoxusText>
    </Center>
  );
});

export function NotificationPanelItemSkeleton() {
  return (
    <NotificationPanelItem disabled skeleton>
      <Skeleton
        variant="circular"
        width={"var(--mantine-spacing-xl)"}
        height={"var(--mantine-spacing-xl)"}
        data-myoxus-ui-role="notification-panel-skeleton-avatar"
      />
      <NotificationPanelItemMain>
        <Skeleton
          variant="text"
          width={"200px"}
          data-myoxus-ui-role="notification-panel-skeleton-title"
        />
        <Skeleton
          variant="text"
          width={`calc(200px / 2)`}
          data-myoxus-ui-role="notification-panel-skeleton-date"
        />
      </NotificationPanelItemMain>
    </NotificationPanelItem>
  );
}
