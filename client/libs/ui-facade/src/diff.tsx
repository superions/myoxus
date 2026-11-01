// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { cssVar, cssTypographyVar } from "@myoxus/theme";
import { SimpleGrid, Box, Text } from "@mantine/core";
import { SettingsListItemMeta } from "./settings/status";

type DiffTone = "added" | "removed" | "changed" | "unchanged";

type JsonPrimitiveTone = "redacted" | "string" | "number" | "boolean";

function diffToneStyle(tone: DiffTone): CSSProperties {
  if (tone === "added") {
    return {
      background: cssVar("backgroundSuccessColor"),
      color: cssVar("successColor"),
    };
  }
  if (tone === "removed") {
    return {
      background: cssVar("backgroundErrorColor"),
      color: cssVar("errorColor"),
    };
  }
  if (tone === "changed") {
    return {
      background: cssVar("backgroundWarningColor"),
      color: cssVar("warningColor"),
    };
  }
  return {
    background: cssVar("backgroundSecondaryColor"),
    color: cssVar("textPrimaryColor"),
  };
}

function jsonPrimitiveColor(tone: JsonPrimitiveTone) {
  if (tone === "redacted") return cssVar("errorColor");
  if (tone === "string") return cssVar("processingColor");
  if (tone === "number") return cssVar("warningColor");
  return cssVar("successColor");
}

/** Prose markers preserve whitespace and semantics without changing document
 * content. Callers supply localized labels; the server theme owns contrast. */
export function DiffInlineText({
  children,
  tone = "unchanged",
  label,
}: PropsWithChildren<{
  tone?: "added" | "removed" | "unchanged";
  label?: string;
}>) {
  // Status ink/paper pairs are designed for badges. Small prose needs stronger
  // contrast in both themes; blend toward the server's primary text ink without
  // inventing a product palette or overriding any existing status role.
  const color =
    tone === "unchanged"
      ? "inherit"
      : `color-mix(in srgb, ${cssVar(tone === "added" ? "successColor" : "errorColor")} 65%, ${cssVar("textPrimaryColor")})`;
  return (
    <Text
      component={tone === "added" ? "ins" : tone === "removed" ? "del" : "span"}
      c={color}
      inherit
      span
      aria-label={label}
      data-myoxus-ui-role={`diff-inline:${tone}`}
      style={{
        ...(tone === "unchanged" ? {} : diffToneStyle(tone)),
        color,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        textDecoration: tone === "removed" ? "line-through" : "none",
      }}
    >
      {children}
    </Text>
  );
}

export function DiffGrid({
  children,
  "data-myoxus-ui-role": uiRole = "diff-grid",
}: PropsWithChildren<{ "data-myoxus-ui-role"?: string }>) {
  return (
    <SimpleGrid
      cols={{ base: 1, lg: 2 }}
      spacing={"var(--mantine-spacing-sm)"}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </SimpleGrid>
  );
}

export function DiffColumn({
  title,
  children,
}: PropsWithChildren<{ title: ReactNode }>) {
  return (
    <Box
      component="section"
      style={{
        minWidth: 0,
        overflow: "hidden",
        border: `1px solid ${cssVar("borderColor")}`,
        borderRadius: "var(--mantine-radius-lg)",
      }}
      data-myoxus-ui-role="diff-column"
    >
      <Box
        style={{
          background: cssVar("backgroundSecondaryColor"),
          paddingBlock:
            "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
          paddingInline: "var(--mantine-spacing-sm)",
        }}
        data-myoxus-ui-role="diff-column-header"
      >
        <SettingsListItemMeta>{title}</SettingsListItemMeta>
      </Box>
      {children}
    </Box>
  );
}

export function DiffList({ children }: PropsWithChildren) {
  return (
    <Box
      component="ol"
      style={{
        maxHeight: "58vh",
        overflow: "auto",
        margin: 0,
        padding: 0,
        listStyle: "none",
      }}
      data-myoxus-ui-role="diff-list"
    >
      {children}
    </Box>
  );
}

export function DiffRow({
  children,
  tone,
}: PropsWithChildren<{ tone: DiffTone }>) {
  return (
    <Box
      component="li"
      style={{
        ...diffToneStyle(tone),
        display: "grid",
        gridTemplateColumns:
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg))\n    minmax(calc(calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-2xl) * 2)), 0.9fr)\n    minmax(0, 1fr)",
        gap: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        paddingBlock: "var(--mantine-spacing-xs)",
        paddingInline:
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        borderTop: `1px solid ${cssVar("borderColor")}`,
      }}
      data-myoxus-ui-role={`diff-row:${tone}`}
    >
      {children}
    </Box>
  );
}

export function DiffLineNumber({ children }: PropsWithChildren) {
  return (
    <Text
      component="span"
      style={{
        userSelect: "none",
        textAlign: "right",
        color: cssVar("placeholderColor"),
      }}
      data-myoxus-ui-role="diff-line-number"
    >
      {children}
    </Text>
  );
}

export function DiffPath({
  children,
  title,
}: PropsWithChildren<{ title?: string }>) {
  return (
    <Text
      component="span"
      title={title}
      style={{
        overflow: "hidden",
        color: cssVar("textSecondaryColor"),
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      data-myoxus-ui-role="diff-path"
    >
      {children}
    </Text>
  );
}

export function DiffValue({ children }: PropsWithChildren) {
  return (
    <Text
      component="code"
      style={{
        minWidth: 0,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        fontFamily: cssTypographyVar(
          "monospace",
          "family",
          cssTypographyVar("body-small", "family", cssVar("fontFamily")),
        ),
      }}
      data-myoxus-ui-role="diff-value"
    >
      {children}
    </Text>
  );
}

export function JsonPrimitiveValue({
  children,
  tone,
}: PropsWithChildren<{ tone: JsonPrimitiveTone }>) {
  return (
    <Text
      component="span"
      style={{ color: jsonPrimitiveColor(tone) }}
      data-myoxus-ui-role={`json-primitive:${tone}`}
    >
      {children}
    </Text>
  );
}
