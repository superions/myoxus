// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { MyoxusText, MyoxusTitle, MyoxusTypography } from "./index";
import {
  myoxusMantineCssVariablesResolver,
  myoxusMantineTheme,
  MyoxusSettingsMantineProvider,
} from "./provider";

afterEach(() => cleanup());

const mergedTheme = mergeMantineTheme(DEFAULT_THEME, myoxusMantineTheme);

function renderWithProvider(ui: ReactNode) {
  return render(
    <MyoxusSettingsMantineProvider>{ui}</MyoxusSettingsMantineProvider>,
  );
}

describe("Myoxus Mantine typography projection", () => {
  test("projects product typography slots into Mantine theme fields", () => {
    for (const slot of [
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
    ] as const) {
      expect(mergedTheme.fontSizes[slot]).toBeDefined();
      expect(mergedTheme.lineHeights[slot]).toBeDefined();
      expect(mergedTheme.fontWeights[slot]).toBeDefined();
    }
  });

  test("exposes typography slots as Mantine CSS variables", () => {
    const { variables } = myoxusMantineCssVariablesResolver(mergedTheme);

    expect(variables["--mantine-font-size-body-small"]).toContain(
      "--myoxus-typography-body-small-size",
    );
    expect(variables["--mantine-line-height-card-title"]).toContain(
      "--myoxus-typography-card-title-line-height",
    );
    expect(variables["--mantine-font-size-nav"]).toContain(
      "--myoxus-typography-nav-size",
    );
    expect(variables["--mantine-font-size-nav"]).not.toContain(
      "var(--mantine-font-size-nav",
    );
    expect(variables["--mantine-font-size-modal-title"]).toContain(
      "--myoxus-typography-modal-title-size",
    );
    expect(variables["--mantine-font-weight-nav"]).toContain(
      "--myoxus-typography-nav-weight",
    );
    expect(variables["--mantine-font-weight-nav"]).not.toContain(
      "var(--mantine-font-weight-nav",
    );
    expect(variables["--mantine-letter-spacing-label-compact"]).toContain(
      "--myoxus-typography-label-compact-letter-spacing",
    );
  });

  test("renders text through Mantine size and color props", () => {
    renderWithProvider(
      <MyoxusText component="span" tone="secondary" typographySlot="body-small">
        Secondary copy
      </MyoxusText>,
    );

    const text = screen.getByText("Secondary copy");
    expect(text.tagName).toBe("SPAN");
    expect(text.dataset.myoxusUiRole).toBe("typography:text:body-small");
    expect(text.getAttribute("style")).toContain(
      "--text-fz: var(--mantine-font-size-body-small)",
    );
    expect(text.getAttribute("style")).toContain(
      "color: var(--mantine-color-myoxus-text-secondary-text)",
    );
  });

  test("forwards semantic live-region roles to the rendered text element", () => {
    renderWithProvider(<MyoxusText role="alert">Invalid value</MyoxusText>);

    expect(screen.getByRole("alert").textContent).toBe("Invalid value");
  });

  test("projects the server-owned emphasis token through a semantic text tone", () => {
    renderWithProvider(
      <MyoxusText component="span" tone="emphasis">
        Active copy
      </MyoxusText>,
    );

    expect(screen.getByText("Active copy").getAttribute("style")).toContain(
      "color: var(--mantine-color-myoxus-text-emphasis-text)",
    );
  });

  test("exposes semantic italic text without consumer-owned style props", () => {
    renderWithProvider(
      <MyoxusText component="em" italic typographySlot="body">
        Supporting context
      </MyoxusText>,
    );

    const text = screen.getByText("Supporting context");
    expect(text.tagName).toBe("EM");
    expect(text.getAttribute("style")).toContain("font-style: italic");
  });

  test("keeps text-only affordances without rebuilding typography styles", () => {
    renderWithProvider(
      <MyoxusText
        component="span"
        preserveWhitespace
        strikethrough
        typographySlot="body"
      >
        {"Line one\nLine two"}
      </MyoxusText>,
    );

    const text = screen.getByText(/Line one/);
    expect(text.getAttribute("style")).toContain("text-decoration");
    expect(text.getAttribute("style")).toContain("white-space: pre-wrap");
    expect(text.getAttribute("style")).toContain("overflow-wrap: anywhere");
    expect(text.getAttribute("style")).not.toContain(
      "--myoxus-typography-body-size",
    );
  });

  test("renders semantic titles through Mantine Title variables", () => {
    renderWithProvider(
      <MyoxusTitle order={2} tone="primary">
        Section title
      </MyoxusTitle>,
    );

    const title = screen.getByRole("heading", {
      level: 2,
      name: "Section title",
    });
    expect(title.dataset.myoxusUiRole).toBe("typography:title:section-title");
    expect(title.getAttribute("style")).toContain(
      "--title-fz: var(--mantine-font-size-section-title",
    );
    expect(title.className).toContain("mantine-Title-root");
  });

  test("wraps rich content in Mantine Typography without local body-copy helpers", () => {
    renderWithProvider(
      <MyoxusTypography>
        <p>Rich document copy</p>
      </MyoxusTypography>,
    );

    const paragraph = screen.getByText("Rich document copy");
    const richBoundary = paragraph.closest(
      '[data-myoxus-ui-role="typography:rich-content"]',
    );

    expect(richBoundary).not.toBeNull();
    expect(richBoundary?.className).toContain("mantine-Typography-root");
  });
});
