// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { Box } from "@mantine/core";
import { cssVar } from "@myoxus/theme";

export function ColorSwatch({
  color,
  foregroundColor,
  outlineColor,
  previewText,
  tagColorRole,
  className,
  shape = "rounded",
  size,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "color-swatch",
}: {
  color?: string;
  foregroundColor?: string;
  outlineColor?: string;
  previewText?: string;
  tagColorRole?: TagColorRole;
  className?: string;
  shape?: "circle" | "rounded";
  size?: number | string;
  "aria-label"?: string;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Box
      component="span"
      className={className}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: previewText ? "center" : undefined,
        color: foregroundColor,
        display: "inline-flex",
        flexShrink: 0,
        justifyContent: previewText ? "center" : undefined,
        width: size ?? "var(--mantine-spacing-md)",
        height: size ?? "var(--mantine-spacing-md)",
        borderRadius:
          shape === "circle"
            ? "var(--mantine-radius-xl)"
            : "var(--mantine-radius-sm)",
        boxShadow: `inset 0 0 0 calc(var(--mantine-scale) * 1px) ${outlineColor ?? cssVar("borderColor")}`,
        backgroundColor: tagColorRole
          ? tagColorRoleSwatch(tagColorRole)
          : color,
      }}
    >
      {previewText}
    </Box>
  );
}

export function ColorDot({
  color,
  className,
  "aria-label": ariaLabel,
}: {
  color: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <ColorSwatch
      aria-label={ariaLabel}
      className={className}
      color={color}
      shape="circle"
      size={"var(--mantine-spacing-xs)"}
      data-myoxus-ui-role="color-dot"
    />
  );
}

export type TagColorRole =
  | "tag.red"
  | "tag.magenta"
  | "tag.orange"
  | "tag.yellow"
  | "tag.green"
  | "tag.teal"
  | "tag.blue"
  | "tag.purple"
  | "tag.grey";

export function tagColorRoleBackground(role: TagColorRole) {
  switch (role) {
    case "tag.red":
      return cssVar("tagRed");
    case "tag.magenta":
      return cssVar("tagMagenta");
    case "tag.orange":
      return cssVar("tagOrange");
    case "tag.yellow":
      return cssVar("tagYellow");
    case "tag.green":
      return cssVar("tagGreen");
    case "tag.teal":
      return cssVar("tagTeal");
    case "tag.blue":
      return cssVar("tagBlue");
    case "tag.purple":
      return cssVar("tagPurple");
    case "tag.grey":
      return cssVar("tagGray");
  }
}

function tagColorRoleSwatch(role: TagColorRole) {
  switch (role) {
    case "tag.red":
      return cssVar("paletteLineRed");
    case "tag.magenta":
      return cssVar("paletteLineMagenta");
    case "tag.orange":
      return cssVar("paletteLineOrange");
    case "tag.yellow":
      return cssVar("paletteLineYellow");
    case "tag.green":
      return cssVar("paletteLineGreen");
    case "tag.teal":
      return cssVar("paletteLineTeal");
    case "tag.blue":
      return cssVar("paletteLineBlue");
    case "tag.purple":
      return cssVar("paletteLinePurple");
    case "tag.grey":
      return cssVar("paletteLineGrey");
  }
}

export function resolveTagColorAccent(
  roles: readonly TagColorRole[],
): string | undefined {
  const colors = [...new Set(roles)]
    .sort()
    .map((role) => tagColorRoleSwatch(role))
    .filter((color): color is string => Boolean(color));
  return colors.reduce<string | undefined>(
    (mixed, color) =>
      mixed ? `color-mix(in srgb, ${mixed} 50%, ${color} 50%)` : color,
    undefined,
  );
}
