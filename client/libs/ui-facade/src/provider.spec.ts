// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { myoxusWebBreakpoints } from "@myoxus/theme";
import { describe, expect, test } from "vitest";

import {
  myoxusMantineCssVariablesResolver,
  myoxusMantineTheme,
} from "./provider";

const mergedTheme = mergeMantineTheme(DEFAULT_THEME, myoxusMantineTheme);
const rawColorLiteralPattern =
  /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:black|white|transparent)\b/i;

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);

  return Object.values(value).flatMap(collectStringValues);
}

describe("Myoxus Mantine provider theme bridge", () => {
  test("projects the global Myoxus theme foundation into Mantine theme fields", () => {
    expect(mergedTheme.primaryColor).toBe("myoxus");
    expect(mergedTheme.primaryShade).toEqual({ light: 5, dark: 5 });
    expect(mergedTheme.autoContrast).toBe(true);
    expect(mergedTheme.defaultRadius).toBe("md");
    expect(mergedTheme.cursorType).toBe("pointer");
    expect(mergedTheme.fontFamily).toContain(
      "--myoxus-typography-ui-font-family",
    );
    expect(mergedTheme.fontFamily).toContain("--myoxus-typography-body-family");
    expect(mergedTheme.fontFamilyMonospace).toContain(
      "--myoxus-typography-mono-font-family",
    );
    expect(mergedTheme.fontFamilyMonospace).toContain(
      "--myoxus-typography-mono-family",
    );

    expect(mergedTheme.colors.myoxus).toHaveLength(10);
    for (const swatch of mergedTheme.colors.myoxus) {
      expect(swatch).toMatch(/^var\(--myoxus-/);
    }

    for (const [size, slot] of [
      ["xs", "body-small"],
      ["sm", "label-compact"],
      ["md", "body"],
      ["lg", "h4"],
      ["xl", "h3"],
      ["page-title", "page-title"],
      ["section-title", "section-title"],
      ["mono", "mono"],
    ] as const) {
      expect(mergedTheme.fontSizes[size]).toContain(
        `--myoxus-typography-${slot}-size`,
      );
    }

    for (const [size, slot] of [
      ["xs", "body-small"],
      ["sm", "label-compact"],
      ["md", "body"],
      ["lg", "blockquote"],
      ["xl", "page-title"],
      ["section-title", "section-title"],
      ["mono", "mono"],
    ] as const) {
      expect(mergedTheme.lineHeights[size]).toContain(
        `--myoxus-typography-${slot}-line-height`,
      );
    }

    expect(mergedTheme.fontWeights.regular).toContain(
      "--myoxus-typography-body-weight",
    );
    expect(mergedTheme.fontWeights.medium).toContain(
      "--myoxus-typography-link-weight",
    );
    expect(mergedTheme.fontWeights.bold).toContain(
      "--myoxus-typography-h1-weight",
    );
    expect(mergedTheme.fontWeights.mono).toContain(
      "--myoxus-typography-mono-weight",
    );
  });

  test("projects all heading, density, radius, shadow and breakpoint slots", () => {
    expect(mergedTheme.headings.fontFamily).toContain(
      "--myoxus-typography-section-title-family",
    );
    expect(mergedTheme.headings.fontWeight).toContain(
      "--myoxus-typography-section-title-weight",
    );
    expect(mergedTheme.headings.textWrap).toBe("pretty");

    const headingSlots = {
      h1: "page-title",
      h2: "section-title",
      h3: "h3",
      h4: "h4",
      h5: "h5",
      h6: "label-compact",
    } as const;

    for (const [heading, slot] of Object.entries(headingSlots)) {
      const style =
        mergedTheme.headings.sizes[
          heading as keyof typeof mergedTheme.headings.sizes
        ];
      expect(style.fontSize).toContain(`--myoxus-typography-${slot}-size`);
      expect(style.lineHeight).toContain(
        `--myoxus-typography-${slot}-line-height`,
      );
      expect(style.fontWeight).toContain(`--myoxus-typography-${slot}-weight`);
    }

    expect(mergedTheme.spacing).toMatchObject({
      "2xs": "calc(0.125rem * var(--mantine-scale))",
      xs: "calc(0.25rem * var(--mantine-scale))",
      sm: "calc(0.5rem * var(--mantine-scale))",
      md: "calc(0.75rem * var(--mantine-scale))",
      lg: "calc(1rem * var(--mantine-scale))",
      xl: "calc(1.5rem * var(--mantine-scale))",
      "2xl": "calc(2rem * var(--mantine-scale))",
    });

    expect(mergedTheme.radius).toMatchObject({
      xs: "calc(0.125rem * var(--mantine-scale))",
      sm: "calc(0.25rem * var(--mantine-scale))",
      md: "calc(0.375rem * var(--mantine-scale))",
      lg: "calc(0.5rem * var(--mantine-scale))",
      xl: "calc(0.75rem * var(--mantine-scale))",
    });

    for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
      expect(mergedTheme.breakpoints[size]).toBe(myoxusWebBreakpoints[size]);
      expect(mergedTheme.breakpoints[size]).not.toContain("var(");
    }

    expect(mergedTheme.shadows).toEqual(DEFAULT_THEME.shadows);
  });

  test("binds Mantine dark chrome variables to server-owned Myoxus tokens", () => {
    const { dark } = myoxusMantineCssVariablesResolver(mergedTheme);

    expect(dark["--mantine-color-body"]).toContain(
      "--myoxus-background-primary-color",
    );
    expect(dark["--mantine-color-text"]).toContain(
      "--myoxus-text-primary-color",
    );
    expect(dark["--mantine-color-default"]).toContain(
      "--myoxus-background-primary-color",
    );
    expect(dark["--mantine-color-default-hover"]).toContain(
      "--myoxus-hover-color",
    );
    expect(dark["--mantine-color-default-border"]).toContain(
      "--myoxus-border-color",
    );
    expect(dark["--mantine-color-myoxus-filled"]).toContain(
      "--myoxus-primary-color",
    );
    expect(dark["--mantine-primary-color-contrast"]).toContain(
      "--myoxus-branding-button-primary-fg",
    );
  });

  test("binds Mantine global CSS variables to Myoxus typography and density tokens", () => {
    const { variables } = myoxusMantineCssVariablesResolver(mergedTheme);

    expect(variables["--mantine-font-family"]).toContain(
      "--myoxus-typography-ui-font-family",
    );
    expect(variables["--mantine-font-family-monospace"]).toContain(
      "--myoxus-typography-mono-font-family",
    );
    expect(variables["--mantine-font-family-headings"]).toContain(
      "--myoxus-typography-section-title-family",
    );
    expect(variables["--mantine-font-size-xs"]).toContain(
      "--myoxus-typography-body-small-size",
    );
    expect(variables["--mantine-font-size-sm"]).toContain(
      "--myoxus-typography-label-compact-size",
    );
    expect(variables["--mantine-font-size-md"]).toContain(
      "--myoxus-typography-body-size",
    );
    expect(variables["--mantine-font-size-nav"]).toContain(
      "--myoxus-typography-nav-size",
    );
    expect(variables["--mantine-line-height-md"]).toContain(
      "--myoxus-typography-body-line-height",
    );
    expect(variables["--mantine-radius-default"]).toBe(
      "calc(0.375rem * var(--mantine-scale))",
    );
  });

  test("sets component defaults, styles and class names from the global foundation", () => {
    expect(mergedTheme.components.Button.defaultProps).toMatchObject({
      autoContrast: true,
      color: "myoxus",
      radius: "md",
    });
    expect(mergedTheme.components.ActionIcon.defaultProps).toMatchObject({
      autoContrast: true,
      color: "myoxus",
      radius: "md",
    });
    expect(mergedTheme.components.Avatar.defaultProps).toMatchObject({
      radius: "xl",
      variant: "light",
    });
    expect(mergedTheme.components.Button.classNames.root).toBe(
      "myoxus-mantine-button",
    );
    expect(mergedTheme.components.Avatar.classNames.root).toBe(
      "myoxus-mantine-avatar",
    );
    expect(mergedTheme.components.Avatar.classNames.placeholder).toBe(
      "myoxus-mantine-avatar-placeholder",
    );
    expect(mergedTheme.components.Menu.classNames).toBeUndefined();
    expect(mergedTheme.components.Switch.classNames.label).toBe(
      "myoxus-mantine-switch-label",
    );
    expect(mergedTheme.components.SegmentedControl.classNames.label).toBe(
      "myoxus-mantine-segmented-control-label",
    );
    expect(mergedTheme.components.Text.classNames.root).toBe(
      "myoxus-mantine-text",
    );
    expect(mergedTheme.components.Title.classNames.root).toBe(
      "myoxus-mantine-title",
    );

    const buttonRootStyle = mergedTheme.components.Button.styles.root;
    expect(buttonRootStyle.fontFamily).toContain(
      "--mantine-font-family-body-small",
    );
    expect(buttonRootStyle.fontSize).toContain(
      "--mantine-font-size-body-small",
    );
    expect(buttonRootStyle.fontWeight).toContain("--mantine-font-weight-link");

    const menuStyles = mergedTheme.components.Menu.styles;
    expect(menuStyles.dropdown.maxHeight).toBeUndefined();
    expect(menuStyles.dropdown.overflowY).toBeUndefined();
    expect(menuStyles.dropdown.overscrollBehavior).toBeUndefined();
    expect(menuStyles.item.fontFamily).toContain("--mantine-font-family-nav");
    expect(menuStyles.item.fontSize).toContain("--mantine-font-size-nav");
    expect(menuStyles.itemLabel.textOverflow).toBe("ellipsis");
    expect(menuStyles.itemSection.color).toBe("currentColor");

    const avatarStyles = mergedTheme.components.Avatar.styles(
      mergedTheme,
      {},
      {},
    );
    expect(avatarStyles.placeholder.background).toContain(
      "--myoxus-primary-color",
    );
    expect(avatarStyles.placeholder.fontFamily).toContain(
      "--mantine-font-family-label-compact",
    );
    expect(avatarStyles.placeholder.fontWeight).toContain(
      "--mantine-font-weight-label-compact",
    );

    expect(mergedTheme.components.Stepper.defaultProps).toMatchObject({
      autoContrast: true,
      color: "myoxus",
      radius: "xl",
      size: "sm",
    });
    const stepperStyles = mergedTheme.components.Stepper.styles;
    expect(stepperStyles.root.fontFamily).toContain(
      "--mantine-font-family-body",
    );
    expect(stepperStyles.stepLabel.fontFamily).toContain(
      "--mantine-font-family-nav",
    );
    expect(stepperStyles.stepLabel.fontSize).toContain(
      "--mantine-font-size-nav",
    );
    expect(stepperStyles.stepDescription.fontFamily).toContain(
      "--mantine-font-family-label-compact",
    );
    expect(stepperStyles.separator.backgroundColor).toContain(
      "--myoxus-border-color",
    );

    expect(mergedTheme.components.Text.defaultProps).toMatchObject({
      c: "myoxus-text-primary",
      size: "body",
    });
    expect(mergedTheme.components.Text.styles).toBeUndefined();
    expect(mergedTheme.components.Title.defaultProps).toMatchObject({
      c: "myoxus-text-primary",
    });
    expect(mergedTheme.components.Typography.defaultProps).toMatchObject({
      c: "myoxus-text-primary",
    });

    const textInputStyle = mergedTheme.components.TextInput.styles.input;
    expect(textInputStyle.background).toContain(
      "--myoxus-background-primary-color",
    );
    expect(textInputStyle.borderColor).toContain("--myoxus-border-color");
    expect(textInputStyle.fontFamily).toContain("--mantine-font-family-body");

    const textInputLabelStyle = mergedTheme.components.TextInput.styles.label;
    expect(textInputLabelStyle.fontFamily).toContain(
      "--mantine-font-family-body",
    );
    expect(textInputLabelStyle.fontSize).toContain("--mantine-font-size-body");
    expect(textInputLabelStyle.fontWeight).toContain(
      "--mantine-font-weight-link",
    );
    expect(
      mergedTheme.components.TextInput.styles.description.fontSize,
    ).toContain("--mantine-font-size-body-small");

    const checkboxLabelStyle = mergedTheme.components.Checkbox.styles(
      mergedTheme,
      {},
    ).label;
    expect(checkboxLabelStyle.fontSize).toContain("--mantine-font-size-body");
    expect(checkboxLabelStyle.fontWeight).toContain(
      "--mantine-font-weight-body",
    );

    expect(mergedTheme.components.Modal.styles.title.fontFamily).toContain(
      "--mantine-font-family-modal-title",
    );
    expect(mergedTheme.components.Drawer.styles.title.fontSize).toContain(
      "--mantine-font-size-modal-title",
    );
    expect(
      collectStringValues(mergedTheme.components).filter((value) =>
        value.includes("--myoxus-typography-"),
      ),
    ).toEqual([]);
    expect(mergedTheme.other.myoxusThemeProjection).toMatchObject({
      colorSource: "server-owned-theme-css",
      typographySource: "cssTypographyVar",
      densitySource: "mantine-theme",
      surfaceSource: "cssVar",
    });
  });

  test("does not expose standalone raw color literals as product theme values", () => {
    const standaloneRawColors = collectStringValues(myoxusMantineTheme).filter(
      (value) =>
        rawColorLiteralPattern.test(value) &&
        !value.includes("var(") &&
        !value.includes("color-mix("),
    );

    expect(standaloneRawColors).toEqual([]);
  });

  test("keeps light and dark Mantine bindings on runtime tokens instead of static palettes", () => {
    const { light, dark } = myoxusMantineCssVariablesResolver(mergedTheme);
    const lightVariables = light as Record<string, string>;
    const darkVariables = dark as Record<string, string>;

    for (const [token, sourceToken] of [
      ["--mantine-color-body", "--myoxus-background-primary-color"],
      ["--mantine-color-text", "--myoxus-text-primary-color"],
      ["--mantine-color-default", "--myoxus-background-primary-color"],
      ["--mantine-primary-color-filled", "--myoxus-primary-color"],
      [
        "--mantine-primary-color-contrast",
        "--myoxus-branding-button-primary-fg",
      ],
    ] as const) {
      expect(lightVariables[token]).toBe(darkVariables[token]);
      expect(lightVariables[token]).toContain(sourceToken);
      expect(lightVariables[token]).not.toMatch(/--myoxus-(?:sem|v2)-/);
      expect(lightVariables[token]).not.toMatch(
        /--mantine-color-(?:dark|gray|blue)-/,
      );
    }
  });
});
