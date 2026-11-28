// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import "@myoxus/theme/style.css";
import "@virgultum/editor/gfx/pointer";

import type { EdgelessRootBlockComponent } from "@virgultum/editor/blocks/root";
import { DefaultTool } from "@virgultum/editor/blocks/surface";
import { ColorScheme } from "@virgultum/editor/model";
import { ThemeProvider } from "@virgultum/editor/shared/services";
import { beforeEach, describe, expect, test } from "vitest";

import { getEdgelessRoot, mountTestSession } from "../../harness/session.js";

describe("ThemeProvider Light/Dark CSS custom property projection", () => {
  let edgeless!: EdgelessRootBlockComponent;

  beforeEach(async () => {
    const styleEl = document.createElement("style");
    styleEl.textContent = `
      [data-theme="light"] {
        --myoxus-hover-color: rgba(0, 0, 0, 0.04) !important;
        --myoxus-tooltip: rgba(0, 0, 0, 1) !important;
      }
      [data-theme="dark"] {
        --myoxus-hover-color: rgba(255, 255, 255, 0.1) !important;
        --myoxus-tooltip: rgba(234, 234, 234, 1) !important;
      }
    `;
    document.head.append(styleEl);

    const dispose = await mountTestSession("edgeless");
    edgeless = getEdgelessRoot(doc, editor, "edgeless");
    edgeless.gfx.tool.setTool(DefaultTool);
    edgeless.gfx.std.get(ThemeProvider).theme$.value = ColorScheme.Light;

    return () => {
      styleEl.remove();
      dispose();
    };
  });

  test("switches color scheme and formats color properties across variants", () => {
    const theme = edgeless.gfx.std.get(ThemeProvider);
    expect(theme.theme).toBe(ColorScheme.Light);

    expect(theme.generateColorProperty("--myoxus-hover-color")).toBe(
      "var(--myoxus-hover-color)",
    );
    expect(theme.generateColorProperty("--myoxus-transparent")).toBe(
      "transparent",
    );
    expect(theme.generateColorProperty("transparent")).toBe("transparent");
    expect(theme.generateColorProperty({ dark: "white", light: "black" })).toBe(
      "black",
    );
    expect(theme.generateColorProperty({ normal: "grey" })).toBe("grey");
    expect(theme.generateColorProperty("", "blue")).toBe("blue");

    theme.theme$.value = ColorScheme.Dark;
    expect(theme.theme).toBe(ColorScheme.Dark);
    expect(theme.generateColorProperty({ dark: "white", light: "black" })).toBe(
      "white",
    );

    theme.theme$.value = ColorScheme.Light;
    expect(theme.theme).toBe(ColorScheme.Light);
  });

  test("resolves Light and Dark CSS custom properties via getComputedStyle", () => {
    const theme = edgeless.gfx.std.get(ThemeProvider);

    expect(theme.getColorValue("--myoxus-transparent")).toBe(
      "--myoxus-transparent",
    );
    expect(
      theme.getColorValue("--myoxus-transparent", "transparent", true),
    ).toBe("transparent");
    expect(
      theme.getColorValue("--myoxus-hover-color", "transparent", true),
    ).toBe("rgba(0, 0, 0, 0.04)");
    expect(theme.getColorValue("--myoxus-tooltip", undefined, true)).toBe(
      "rgba(0, 0, 0, 1)",
    );
    expect(
      theme.getColorValue({ dark: "white", light: "black" }, undefined, true),
    ).toBe("black");
    expect(
      theme.getColorValue({ dark: "white", light: "" }, undefined, true),
    ).toBe("transparent");
    expect(theme.getColorValue({ normal: "grey" }, undefined, true)).toBe(
      "grey",
    );

    theme.theme$.value = ColorScheme.Dark;
    expect(
      theme.getColorValue("--myoxus-hover-color", "transparent", true),
    ).toBe("rgba(255, 255, 255, 0.1)");
    expect(theme.getColorValue("--myoxus-tooltip", undefined, true)).toBe(
      "rgba(234, 234, 234, 1)",
    );
  });
});
