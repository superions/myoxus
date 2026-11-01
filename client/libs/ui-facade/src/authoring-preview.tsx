// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { Card as MantineCard } from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import { type SelectableCardRowProps, SelectableCardRow } from "./card";
import { DoneIcon } from "@myoxus/icons/react";
import { type PropsWithChildren, type AnchorHTMLAttributes } from "react";

export function AuthoringPreviewSurface({
  children,
  className,
  style,
  "data-authoring-preview-kind": previewKind,
  "data-testid": dataTestId,
  ...props
}: RoleBoxProps) {
  // Authoring previews intentionally render user-editable theme/font/color
  // values inside the surface. Keep the exception central and explicitly
  // marked so visual gates can ignore preview typography while still checking
  // the surrounding settings chrome.
  return (
    <MantineCard
      {...props}
      className={joinClassName("myoxus-authoring-preview-surface", className)}
      data-admin-visual-role="authoring-preview"
      data-authoring-preview-kind={previewKind as string | undefined}
      data-testid={dataTestId}
      data-myoxus-ui-role="authoring-preview-surface"
      p={"var(--mantine-spacing-sm)"}
      style={style}
    >
      {children}
    </MantineCard>
  );
}

export function AuthoringColorPreview({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <AuthoringPreviewSurface
      {...props}
      className={joinClassName("myoxus-authoring-color-preview", className)}
      data-authoring-preview-kind="color-schema"
      style={{
        background:
          "var(--authoring-color-paper, var(--myoxus-background-primary-color))",
        color: "var(--authoring-color-ink, var(--myoxus-text-primary-color))",
        ...style,
      }}
    >
      {children}
    </AuthoringPreviewSurface>
  );
}

export function AuthoringColorPreviewSample({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <div
      {...props}
      className={joinClassName(
        "myoxus-authoring-color-preview-sample",
        className,
      )}
      data-myoxus-ui-role="authoring-color-preview-sample"
      style={style}
    >
      {children}
    </div>
  );
}

export function AuthoringColorPreviewLine({
  className,
  style,
  tone = "rule",
  width = "medium",
  ...props
}: Omit<RoleBoxProps, "children"> & {
  tone?: "accent" | "rule";
  width?: "short" | "medium" | "long";
}) {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={joinClassName(
        "myoxus-authoring-color-preview-line",
        className,
      )}
      data-myoxus-ui-role="authoring-color-preview-line"
      data-tone={tone}
      data-width={width}
      style={style}
    />
  );
}

export type AuthoringPreviewCardProps = SelectableCardRowProps & {
  active?: boolean;
};

/**
 * Selectable authoring preview card for theme/font/color choices. The card may
 * receive per-record preview CSS variables, but the reusable layout chrome
 * stays in the Facade instead of route-local Admin CSS.
 */
export function AuthoringPreviewCard({
  active,
  className,
  selected,
  style,
  "data-myoxus-ui-role": uiRole = "button:authoring-preview-card",
  ...props
}: AuthoringPreviewCardProps) {
  const isSelected = active ?? selected ?? false;
  return (
    <SelectableCardRow
      {...props}
      className={joinClassName("myoxus-authoring-preview-card", className)}
      data-admin-visual-role="authoring-preview"
      selected={isSelected}
      data-active={isSelected ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      style={{
        background: "var(--theme-card-paper)",
        borderColor: isSelected
          ? "var(--theme-card-accent)"
          : "var(--theme-card-rule)",
        color: "var(--theme-card-ink)",
        ...style,
      }}
    />
  );
}

export function AuthoringPreviewCheck({
  className,
  style,
}: Omit<RoleBoxProps, "children">) {
  return (
    <span
      aria-hidden
      className={joinClassName("myoxus-authoring-preview-check", className)}
      data-myoxus-ui-role="authoring-preview-check"
      style={style}
    >
      <DoneIcon className="myoxus-authoring-preview-check-icon" />
    </span>
  );
}

export function AuthoringPreviewHeader({
  children,
  className,
  style,
}: RoleBoxProps) {
  return (
    <header
      className={joinClassName("myoxus-authoring-preview-header", className)}
      data-myoxus-ui-role="authoring-preview-header"
      style={style}
    >
      {children}
    </header>
  );
}

export function AuthoringPreviewTitle({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <h2
      className={joinClassName("myoxus-authoring-preview-title", className)}
      data-myoxus-ui-role="authoring-preview-title"
      data-testid={dataTestId}
      style={style}
    >
      {children}
    </h2>
  );
}

export function AuthoringPreviewTagline({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <p
      className={joinClassName("myoxus-authoring-preview-tagline", className)}
      data-myoxus-ui-role="authoring-preview-tagline"
      data-testid={dataTestId}
      style={style}
    >
      {children}
    </p>
  );
}

export function AuthoringPreviewDescription({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <p
      className={joinClassName(
        "myoxus-authoring-preview-description",
        className,
      )}
      data-myoxus-ui-role="authoring-preview-description"
      data-testid={dataTestId}
      style={style}
    >
      {children}
    </p>
  );
}

type AuthoringTypographyHeadingLevel = 1 | 2 | 3 | 4 | 5;

export function AuthoringTypographyPreview({
  children,
  className,
  style,
  "data-testid": dataTestId,
}: RoleBoxProps) {
  return (
    <AuthoringPreviewSurface
      className={joinClassName(
        "myoxus-authoring-typography-preview",
        className,
      )}
      data-testid={dataTestId}
      style={style}
    >
      {children}
    </AuthoringPreviewSurface>
  );
}

export function AuthoringTypographyHeading({
  children,
  className,
  level,
  ...props
}: RoleBoxProps & {
  level: AuthoringTypographyHeadingLevel;
}) {
  const headingProps = {
    ...props,
    className: joinClassName("myoxus-authoring-typography-heading", className),
    "data-level": String(level),
    "data-myoxus-ui-role": "authoring-typography-heading",
  };
  if (level === 1) return <h1 {...headingProps}>{children}</h1>;
  if (level === 2) return <h2 {...headingProps}>{children}</h2>;
  if (level === 3) return <h3 {...headingProps}>{children}</h3>;
  if (level === 4) return <h4 {...headingProps}>{children}</h4>;
  return <h5 {...headingProps}>{children}</h5>;
}

export function AuthoringTypographyText({
  children,
  className,
  component: Component = "p",
  style,
  "data-myoxus-ui-role": uiRole = "authoring-typography-text",
  variant = "body",
  ...props
}: RoleBoxProps & {
  component?: "p" | "span";
  variant?: "body" | "bodySmall";
}) {
  return (
    <Component
      {...props}
      className={joinClassName("myoxus-authoring-typography-text", className)}
      data-myoxus-ui-role={uiRole}
      data-variant={variant}
      style={style}
    >
      {children}
    </Component>
  );
}

/** Link specimens inside selectable cards are non-interactive to avoid nested controls. */
export function AuthoringTypographyLink({
  component: Component = "a",
  children,
  className,
  ...props
}: PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement>> & {
  component?: "a" | "span";
}) {
  return (
    <Component
      {...props}
      className={joinClassName("myoxus-authoring-typography-link", className)}
      data-myoxus-ui-role="authoring-typography-link"
    >
      {children}
    </Component>
  );
}

export function AuthoringTypographyQuote({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "authoring-typography-quote",
  ...props
}: RoleBoxProps) {
  return (
    <blockquote
      {...props}
      className={joinClassName("myoxus-authoring-typography-quote", className)}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </blockquote>
  );
}

export function AuthoringTypographyCode({
  children,
  className,
  variant = "inline",
  style,
  "data-myoxus-ui-role": uiRole = "authoring-typography-code",
  ...props
}: RoleBoxProps & {
  variant?: "inline" | "block";
}) {
  const Component = variant === "block" ? "pre" : "code";
  return (
    <Component
      {...props}
      className={joinClassName("myoxus-authoring-typography-code", className)}
      data-myoxus-ui-role={uiRole}
      data-variant={variant}
      style={style}
    >
      {children}
    </Component>
  );
}
