// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type HTMLAttributes,
  type CSSProperties,
  type ButtonHTMLAttributes,
  forwardRef,
  type ForwardedRef,
  type PropsWithChildren,
  type ReactNode,
  type MouseEventHandler,
} from "react";
import { type CardPadding, CARD_PADDING_BY_SIZE } from "./card-padding";
import { cssVar } from "@myoxus/theme";
import {
  Card as MantineCard,
  UnstyledButton as MantineUnstyledButton,
  Group,
  Box,
  Stack,
  Text,
} from "@mantine/core";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { MyoxusTitle, MyoxusText } from "./typography";

type CardComponent = "a" | "article" | "button" | "div" | "section";

export type CardProps = HTMLAttributes<HTMLElement> & {
  component?: CardComponent;
  display?: CSSProperties["display"];
  flexDirection?: CSSProperties["flexDirection"];
  fullHeight?: boolean;
  href?: string;
  height?: CSSProperties["height"];
  interactive?: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  minHeight?: CSSProperties["minHeight"];
  overflow?: CSSProperties["overflow"];
  padding?: CardPadding;
  rel?: string;
  target?: string;
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  withBorder?: boolean;
  "data-myoxus-ui-role"?: string;
};

/**
 * Generic surface card for product panels. It exposes semantic padding and role
 * hooks; ordinary surface chrome belongs to the Mantine theme.
 */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  {
    children,
    className,
    component = "div",
    display,
    flexDirection,
    fullHeight = false,
    height,
    href,
    interactive = false,
    maxHeight,
    minHeight,
    overflow,
    padding = "none",
    rel,
    style,
    target,
    type,
    withBorder = false,
    "data-myoxus-ui-role": uiRole = "card",
    ...props
  },
  ref,
) {
  const cardStyle: CSSProperties = {
    display,
    flexDirection,
    appearance: component === "button" ? "none" : undefined,
    height: fullHeight ? "100%" : height,
    maxHeight,
    minHeight,
    overflow,
    cursor: interactive ? "pointer" : undefined,
    textAlign: interactive ? "start" : undefined,
    ...style,
  };

  if (component === "a") {
    return (
      <MantineCard
        {...props}
        component="a"
        ref={ref as ForwardedRef<HTMLAnchorElement>}
        className={className}
        href={href}
        p={CARD_PADDING_BY_SIZE[padding]}
        withBorder={withBorder}
        rel={rel}
        style={cardStyle}
        target={target}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineCard>
    );
  }

  if (component === "button") {
    return (
      <MantineCard
        {...props}
        component="button"
        ref={ref as ForwardedRef<HTMLButtonElement>}
        className={className}
        p={CARD_PADDING_BY_SIZE[padding]}
        withBorder={withBorder}
        style={cardStyle}
        type={type ?? "button"}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineCard>
    );
  }

  if (component === "article") {
    return (
      <MantineCard
        {...props}
        component="article"
        ref={ref as ForwardedRef<HTMLElement>}
        className={className}
        p={CARD_PADDING_BY_SIZE[padding]}
        withBorder={withBorder}
        style={cardStyle}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineCard>
    );
  }

  if (component === "section") {
    return (
      <MantineCard
        {...props}
        component="section"
        ref={ref as ForwardedRef<HTMLElement>}
        className={className}
        p={CARD_PADDING_BY_SIZE[padding]}
        withBorder={withBorder}
        style={cardStyle}
        data-myoxus-ui-role={uiRole}
      >
        {children}
      </MantineCard>
    );
  }

  return (
    <MantineCard
      {...props}
      ref={ref as ForwardedRef<HTMLDivElement>}
      className={className}
      p={CARD_PADDING_BY_SIZE[padding]}
      withBorder={withBorder}
      style={cardStyle}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MantineCard>
  );
});

export function DisclosureCard({
  children,
  expanded,
  "data-myoxus-ui-role": uiRole = "disclosure-card",
  ...props
}: CardProps & { expanded?: boolean }) {
  return (
    <Card
      {...props}
      data-expanded={expanded === undefined ? undefined : String(expanded)}
      data-myoxus-ui-role={uiRole}
      padding={props.padding ?? "sm"}
    >
      {children}
    </Card>
  );
}

export function DisclosureCardTrigger({
  children,
  className,
  expanded,
  style,
  "data-myoxus-ui-role": uiRole = "disclosure-card-trigger",
  ...props
}: PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    expanded?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <MantineUnstyledButton
      {...props}
      className={className}
      data-expanded={expanded === undefined ? undefined : String(expanded)}
      data-myoxus-ui-role={uiRole}
      style={style}
      type={props.type ?? "button"}
    >
      <Group align="center" gap="xs" wrap="nowrap">
        {children}
      </Group>
    </MantineUnstyledButton>
  );
}

export function DisclosureCardIndicator({
  className,
  expanded,
  style,
  "aria-hidden": ariaHidden = true,
  "data-myoxus-ui-role": uiRole = "disclosure-card-indicator",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  expanded?: boolean;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Box
      {...props}
      aria-hidden={ariaHidden}
      className={className}
      component="span"
      data-expanded={expanded === undefined ? undefined : String(expanded)}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
    </Box>
  );
}

export type SelectableCardRowProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  appearance?: "card" | "row";
  selected?: boolean;
  density?: "default" | "compact";
  layout?: "default" | "media";
  "data-myoxus-ui-role"?: string;
};

/**
 * Button-backed card row for master/detail selections and operational lists.
 * Active state is token-driven; do not add local hover/active CSS in route code
 * unless a documented technical geometry exception owns it.
 */
export function SelectableCardRow({
  appearance = "card",
  children,
  className,
  density = "default",
  layout = "default",
  selected = false,
  style,
  "data-myoxus-ui-role": uiRole = "button:card-row",
  ...props
}: SelectableCardRowProps) {
  const background =
    selected && appearance === "row"
      ? `color-mix(in srgb, ${cssVar(
          "backgroundSecondaryColor",
        )} 92%, ${cssVar("primaryColor")} 8%)`
      : undefined;
  const borderColor = selected
    ? cssVar("primaryColor")
    : appearance === "row"
      ? "transparent"
      : undefined;

  return (
    <MantineCard
      {...props}
      component="button"
      withBorder
      radius={appearance === "row" ? "sm" : undefined}
      p={
        density === "compact"
          ? appearance === "row"
            ? "var(--mantine-spacing-xs)"
            : "xs"
          : "md"
      }
      className={className}
      aria-pressed={selected}
      data-appearance={appearance}
      data-layout={layout}
      data-selected={selected ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        width: "100%",
        ...(borderColor ? { borderColor } : {}),
        ...(background ? { background } : {}),
        display: layout === "media" ? "grid" : undefined,
        flexShrink: 0,
        gap:
          layout === "media"
            ? "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"
            : undefined,
        gridTemplateColumns:
          layout === "media"
            ? `calc(var(--mantine-spacing-2xl) * 2) minmax(0, 1fr)`
            : undefined,
        textAlign: "start",
        ...style,
      }}
    >
      {children}
    </MantineCard>
  );
}

export function CardHeader({
  children,
  className,
  padding = "lg",
  style,
  "data-myoxus-ui-role": uiRole = "card-header",
  ...props
}: CardProps) {
  return (
    <Stack
      {...props}
      className={className}
      gap="xs"
      p={CARD_PADDING_BY_SIZE[padding]}
      pb={CARD_PADDING_BY_SIZE.md}
      style={style}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Stack>
  );
}

/** CardHeader owns the top inset; content padding adds only sides and bottom. */
export function CardContent({
  children,
  className,
  padding,
  style,
  "data-myoxus-ui-role": uiRole = "card-content",
  ...props
}: CardProps) {
  return (
    <Box
      {...props}
      component="div"
      className={className}
      p={CARD_PADDING_BY_SIZE[padding ?? "lg"]}
      pt={0}
      style={style}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export function CardTitle({
  children,
  className,
  icon,
  style,
  "data-myoxus-ui-role": uiRole = "card-title",
  ...props
}: CardProps & { icon?: ReactNode }) {
  return (
    <MyoxusTitle
      {...props}
      order={3}
      className={className}
      typographySlot="card-title"
      fallbackSlot="body-small"
      style={{
        alignItems: icon ? "center" : undefined,
        display: icon ? "inline-flex" : undefined,
        gap: icon ? "var(--mantine-spacing-xs)" : undefined,
        margin: 0,
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {icon}
      {children}
    </MyoxusTitle>
  );
}

export function CardDescription({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "card-description",
  ...props
}: CardProps) {
  return (
    <MyoxusText
      {...props}
      component="p"
      className={className}
      tone="secondary"
      typographySlot="body-small"
      style={{
        margin: 0,
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MyoxusText>
  );
}

export type BlockCardProps = PropsWithChildren<{
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onAuxClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
  "data-testid"?: string;
}>;

export function BlockCard({
  title,
  desc,
  right,
  onClick,
  onAuxClick,
  className,
  children,
  "data-testid": dataTestId,
}: BlockCardProps) {
  return (
    <MantineCard
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role="action-card"
      p={CARD_PADDING_BY_SIZE.md}
      onClick={onClick}
      onAuxClick={onAuxClick}
      style={{
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Stack gap="2xs" style={{ minWidth: 0 }}>
          <Text>{title}</Text>
          {desc ? <Text c="dimmed">{desc}</Text> : null}
          {children}
        </Stack>
        {right ? <Box style={{ flex: "0 0 auto" }}>{right}</Box> : null}
      </Group>
    </MantineCard>
  );
}
