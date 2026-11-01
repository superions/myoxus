// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Server-theme-backed typography primitives for every Myoxus client.
 *
 * This module is intentionally independent from the Facade barrel so settings,
 * shell and feature modules can share typography without creating barrel
 * cycles.
 */
import {
  Collapse as MantineCollapse,
  Flex as MantineFlex,
  Text,
  type TextProps as MantineTextProps,
  Title,
  type TitleProps as MantineTitleProps,
  Typography as MantineTypography,
  type TypographyProps as MantineTypographyProps,
} from "@mantine/core";
import type {
  ComponentProps,
  CSSProperties,
  HTMLAttributes,
  MouseEventHandler,
  PropsWithChildren,
} from "react";
import "./typography.css";

export type MyoxusTypographySlot =
  | "blockquote"
  | "body"
  | "body-large"
  | "body-small"
  | "caption"
  | "card-title"
  | "code-block"
  | "dense-label"
  | "heading-small"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "label-compact"
  | "link"
  | "modal-title"
  | "mono"
  | "nav"
  | "page-title"
  | "section"
  | "section-title"
  | (string & {});

export type MyoxusTextTone =
  | "annotation"
  | "accent"
  | "emphasis"
  | "primary"
  | "secondary"
  | "tertiary"
  | "muted"
  | "link"
  | "danger"
  | "success"
  | "warning";

export type MyoxusTextComponent =
  | "a"
  | "div"
  | "em"
  | "label"
  | "li"
  | "p"
  | "small"
  | "span"
  | "strong"
  | "time"
  | "h3";

export type SettingsHeadingLevel = 1 | 2 | 3 | 4 | 5;

const MYOXUS_MANTINE_TYPOGRAPHY_SLOTS = new Set<string>([
  "blockquote",
  "body",
  "body-large",
  "body-small",
  "caption",
  "card-title",
  "code-block",
  "dense-label",
  "heading-small",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label-compact",
  "link",
  "modal-title",
  "mono",
  "nav",
  "page-title",
  "section",
  "section-title",
]);

export const MYOXUS_TEXT_TONE_COLOR: Record<MyoxusTextTone, string> = {
  annotation: "myoxus-text-annotation",
  accent: "myoxus-text-accent",
  danger: "myoxus-text-danger",
  emphasis: "myoxus-text-emphasis",
  link: "myoxus-text-link",
  muted: "myoxus-text-muted",
  primary: "myoxus-text-primary",
  secondary: "myoxus-text-secondary",
  success: "myoxus-text-success",
  tertiary: "myoxus-text-tertiary",
  warning: "myoxus-text-warning",
};

function resolveMantineTypographySlot(
  slot: MyoxusTypographySlot | undefined,
  fallbackSlot: MyoxusTypographySlot | undefined,
) {
  const requestedSlot = slot ?? "body";
  if (MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.has(requestedSlot)) {
    return requestedSlot;
  }

  const fallback = fallbackSlot ?? "body-small";
  return MYOXUS_MANTINE_TYPOGRAPHY_SLOTS.has(fallback) ? fallback : "body";
}

export function typographyFontWeightVar(slot: string) {
  return `var(--mantine-font-weight-${slot}, var(--mantine-font-weight-regular))`;
}

export function typographyLetterSpacingVar(slot: string) {
  return `var(--mantine-letter-spacing-${slot}, 0em)`;
}

export function typographyFontFamilyVar(slot: string) {
  return `var(--mantine-font-family-${slot}, var(--mantine-font-family))`;
}

function titleMantineVars(slot: string) {
  return {
    root: {
      "--title-fw": typographyFontWeightVar(slot),
      "--title-fz": `var(--mantine-font-size-${slot}, var(--mantine-h2-font-size))`,
      "--title-lh": `var(--mantine-line-height-${slot}, var(--mantine-h2-line-height))`,
    },
  };
}

type ForbiddenMyoxusTypographyProps =
  | "c"
  | "color"
  | "ff"
  | "fs"
  | "fw"
  | "fz"
  | "lh"
  | "lts"
  | "size"
  | "td"
  | "vars";

export type MyoxusTextProps = Omit<
  MantineTextProps,
  ForbiddenMyoxusTypographyProps | "component" | "style"
> &
  PropsWithChildren<{
    component?: MyoxusTextComponent;
    dateTime?: string;
    fallbackSlot?: MyoxusTypographySlot;
    flexShrink?: CSSProperties["flexShrink"];
    href?: string;
    htmlFor?: string;
    id?: string;
    /** Uses Mantine's font-style projection without exposing raw style props. */
    italic?: boolean;
    maxWidth?: CSSProperties["maxWidth"];
    minWidth?: CSSProperties["minWidth"];
    onClick?: MouseEventHandler<HTMLElement>;
    /** Gently pulses ongoing status text; respects reduced-motion preferences. */
    pending?: boolean;
    preserveWhitespace?: boolean;
    rel?: string;
    role?: HTMLAttributes<HTMLElement>["role"];
    style?: CSSProperties;
    strikethrough?: boolean;
    target?: string;
    textAlign?: CSSProperties["textAlign"];
    title?: string;
    tone?: MyoxusTextTone;
    typographySlot?: MyoxusTypographySlot;
    "data-myoxus-ui-role"?: string;
  }>;

export function MyoxusText({
  children,
  component,
  fallbackSlot,
  flexShrink,
  italic = false,
  maxWidth,
  minWidth,
  pending = false,
  preserveWhitespace = false,
  style,
  strikethrough = false,
  ta,
  textAlign,
  tone = "primary",
  typographySlot = "body",
  "data-myoxus-ui-role": uiRole = `typography:text:${typographySlot}`,
  ...props
}: MyoxusTextProps) {
  const resolvedSlot = resolveMantineTypographySlot(
    typographySlot,
    fallbackSlot,
  );

  return (
    <Text
      {...props}
      component={component}
      c={MYOXUS_TEXT_TONE_COLOR[tone]}
      data-myoxus-ui-role={uiRole}
      data-myoxus-text-pending={pending || undefined}
      // A documented authoring preview may provide its own font family; all
      // ordinary copy continues to inherit the server-projected slot family.
      ff={style?.fontFamily ?? typographyFontFamilyVar(resolvedSlot)}
      fs={italic ? "italic" : undefined}
      fw={typographyFontWeightVar(resolvedSlot)}
      lts={typographyLetterSpacingVar(resolvedSlot)}
      size={resolvedSlot}
      ta={textAlign ?? ta}
      td={strikethrough ? "line-through" : undefined}
      style={{
        flexShrink,
        maxWidth,
        minWidth,
        overflowWrap: preserveWhitespace ? "anywhere" : undefined,
        whiteSpace: preserveWhitespace ? "pre-wrap" : undefined,
        ...style,
      }}
    >
      {children}
    </Text>
  );
}

export type MyoxusTitleProps = Omit<
  MantineTitleProps,
  ForbiddenMyoxusTypographyProps | "style"
> &
  PropsWithChildren<{
    fallbackSlot?: MyoxusTypographySlot;
    style?: CSSProperties;
    textAlign?: CSSProperties["textAlign"];
    tone?: MyoxusTextTone;
    typographySlot?: MyoxusTypographySlot;
    "data-myoxus-ui-role"?: string;
  }>;

export function MyoxusTitle({
  children,
  fallbackSlot,
  order = 2,
  style,
  ta,
  textAlign,
  tone = "primary",
  typographySlot,
  "data-myoxus-ui-role": uiRole,
  ...props
}: MyoxusTitleProps) {
  const implicitSlot =
    order === 1 ? "page-title" : order === 2 ? "section-title" : "card-title";
  const resolvedSlot = resolveMantineTypographySlot(
    typographySlot ?? implicitSlot,
    fallbackSlot ?? implicitSlot,
  );

  return (
    <Title
      {...props}
      order={order}
      c={MYOXUS_TEXT_TONE_COLOR[tone]}
      data-myoxus-ui-role={uiRole ?? `typography:title:${resolvedSlot}`}
      ff={typographyFontFamilyVar(resolvedSlot)}
      lts={typographyLetterSpacingVar(resolvedSlot)}
      ta={textAlign ?? ta}
      vars={() => titleMantineVars(resolvedSlot)}
      style={style}
    >
      {children}
    </Title>
  );
}

export type MyoxusTypographyProps = MantineTypographyProps &
  PropsWithChildren<{
    "data-myoxus-ui-role"?: string;
  }>;

export const Typography = MantineTypography;
export type CollapseProps = ComponentProps<typeof MantineCollapse>;
export const Collapse = MantineCollapse;

// Direct Mantine layout primitive for technical split panes. Product code uses
// this thin Facade export instead of recreating a visual wrapper API.
export const Flex = MantineFlex;

export function MyoxusTypography({
  children,
  "data-myoxus-ui-role": uiRole = "typography:rich-content",
  ...props
}: MyoxusTypographyProps) {
  return (
    <MantineTypography {...props} data-myoxus-ui-role={uiRole}>
      {children}
    </MantineTypography>
  );
}
