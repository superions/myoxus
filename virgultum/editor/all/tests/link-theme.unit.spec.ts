import pageShellStyles from "../../../../client/libs/ui-facade/src/page-shell.css?raw";
import { listBlockStyles } from "../../../content/src/blocks/list/styles";
import { codeBlockStyles } from "../../../content/src/blocks/code/styles";
import { signal } from "@preact/signals-core";
import { setInlineStyles, VText } from "@virgultum/core/runtime/inline";
import { userEvent } from "vitest/browser";
import { myoxusTextStyles } from "../../../core/src/styles/text.js";
import { documentTitleStyles } from "../../../content/src/doc-title/doc-title";
import { paragraphBlockStyles } from "../../../content/src/blocks/paragraph/styles";
import { afterEach, describe, expect, test } from "vitest";

import { MyoxusLink } from "../../../content/src/inlines/link/link-node/myoxus-link";

if (!customElements.get("v-text")) customElements.define("v-text", VText);

if (!customElements.get("myoxus-link"))
  customElements.define("myoxus-link", MyoxusLink);

function makeLink() {
  const message$ = signal(null);
  return Object.assign(document.createElement("myoxus-link"), {
    std: { get: () => ({ message$ }) },
  });
}

afterEach(() =>
  document
    .querySelectorAll("body > myoxus-link")
    .forEach((link) => link.remove()),
);

describe("editor link theme projection", () => {
  test("uses theme defaults while retaining authored emphasis and strike", () => {
    const link = makeLink();
    link.delta = {
      insert: "Readable link",
      attributes: { link: "https://example.com", strike: true },
    };
    const container = link;
    document.body.append(link);
    const anchor = container.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com");
    expect(anchor.style.fontWeight).toBe(
      "var(--myoxus-typography-link-weight)",
    );
    expect(anchor.style.fontFamily).toBe(
      "var(--myoxus-typography-link-family)",
    );
    expect(anchor.style.textDecoration).toBe("");
    expect(container.querySelector("v-text")?.getAttribute("style")).toContain(
      "line-through",
    );

    link.delta = {
      insert: "Emphasized link",
      attributes: {
        link: "https://example.com",
        bold: true,
        italic: true,
        underline: true,
      },
    };
    expect(anchor.style.fontWeight).toBe("bolder");
    expect(anchor.style.fontStyle).toBe("italic");
    expect(container.querySelector("v-text")?.getAttribute("style")).toContain(
      "underline",
    );
  });

  test("keeps code links in their code font without suppressing link decoration", () => {
    const link = makeLink();
    link.delta = {
      insert: "linked_code",
      attributes: { link: "https://example.com", code: true },
    };
    const container = link;
    document.body.append(link);
    expect(container.querySelector("code")?.style.fontFamily).toBe(
      "var(--myoxus-typography-mono-family)",
    );
    const anchor = container.querySelector("code a")! as HTMLAnchorElement;
    expect(anchor.style.fontFamily).toBe("");
    expect(anchor.style.textDecoration).toBe("");
  });
});

test("rendered links and headings respond to theme changes, with inherited text emphasis", async () => {
  const container = document.createElement("div");
  const style = document.createElement("style");
  style.textContent = paragraphBlockStyles + documentTitleStyles;
  container.append(style);
  const link = makeLink();
  link.delta = {
    insert: "Theme link",
    attributes: { link: "https://example.com" },
  };
  const linkHost = link;
  container.append(link);
  const heading = document.createElement("div");
  heading.className = "h2";
  heading.textContent = "Theme heading";
  container.append(heading);
  const title = document.createElement("div");
  title.className = "doc-title-container";
  title.textContent = "Theme document title";
  container.append(title);
  const emphasized = document.createElement("div");
  emphasized.style.fontStyle = "italic";
  const emphasis = document.createElement("span");
  emphasis.textContent = "Inherited emphasis";
  setInlineStyles(emphasis, myoxusTextStyles({}));
  emphasized.append(emphasis);
  container.append(emphasized);
  document.body.append(container);
  try {
    for (const [family, size, weight, decoration] of [
      ["serif", "27px", "700", "underline"],
      ["sans-serif", "24px", "500", "overline"],
    ]) {
      for (const role of ["link", "h2", "page-title"]) {
        container.style.setProperty(
          `--myoxus-typography-${role}-family`,
          family,
        );
        container.style.setProperty(`--myoxus-typography-${role}-size`, size);
        container.style.setProperty(
          `--myoxus-typography-${role}-weight`,
          weight,
        );
        container.style.setProperty(
          `--myoxus-typography-${role}-font-style`,
          "italic",
        );
        container.style.setProperty(
          `--myoxus-typography-${role}-line-height`,
          "1.4",
        );
        container.style.setProperty(
          `--myoxus-typography-${role}-letter-spacing`,
          "0.02em",
        );
      }
      container.style.setProperty(
        "--myoxus-font-h-2",
        "var(--myoxus-typography-h2-size)",
      );
      container.style.setProperty(
        "--myoxus-typography-link-decoration",
        decoration,
      );
      const anchor = linkHost.querySelector("a")!;
      for (const element of [anchor, heading, title]) {
        const computed = getComputedStyle(element);
        expect(computed.fontFamily).toBe(family);
        expect(computed.fontSize).toBe(size);
        expect(computed.fontWeight).toBe(weight);
        expect(computed.fontStyle).toBe("italic");
        expect(parseFloat(computed.lineHeight)).toBeCloseTo(
          parseFloat(size) * 1.4,
          1,
        );
      }
      expect(getComputedStyle(anchor).textDecorationLine).toBe(decoration);
    }
    const anchor = linkHost.querySelector("a")!;
    container.style.setProperty(
      "--myoxus-typography-link-hover-decoration",
      "underline",
    );
    await userEvent.hover(anchor);
    expect(getComputedStyle(anchor).textDecorationLine).toBe("underline");
    await userEvent.unhover(anchor);
    expect(getComputedStyle(anchor).textDecorationLine).toBe("overline");
    emphasized.tabIndex = 0;
    emphasized.focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(anchor);
    expect(anchor.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(anchor).textDecorationLine).toBe("underline");
    expect(getComputedStyle(emphasized.querySelector("span")!).fontStyle).toBe(
      "italic",
    );
  } finally {
    container.remove();
  }
}, 5000);

test("personal reading size scales page typography, follows theme changes and resets without changing chrome", async () => {
  const outer = document.createElement("div");
  outer.style.cssText =
    "font-size: 14px; --myoxus-font-base: 14px; --myoxus-font-h-2: 24px; --myoxus-typography-body-size: 14px; --myoxus-typography-h2-size: 24px; --myoxus-typography-page-title-size: 30px; --myoxus-typography-link-size: 14px; --myoxus-typography-mono-size: 13px; --myoxus-typography-code-block-size: 13px; --myoxus-typography-h2-line-height: 1.25;";
  const root = document.createElement("div");
  root.className = "myoxus-document-editor-root";
  root.dataset.editorMode = "page";
  const style = document.createElement("style");
  style.textContent =
    pageShellStyles +
    paragraphBlockStyles +
    listBlockStyles +
    codeBlockStyles +
    documentTitleStyles;
  // A nested theme scope redefines the base, as the actual page editor does.
  const content = document.createElement("div");
  content.style.setProperty(
    "--myoxus-font-base",
    "var(--myoxus-typography-body-size)",
  );
  content.innerHTML =
    '<myoxus-paragraph>Body</myoxus-paragraph><myoxus-list>List</myoxus-list><div class="h2">Heading</div><div class="doc-title-container">Title</div><div class="myoxus-code-block-container">Code block</div>';
  const inline = document.createElement("div");
  const code = document.createElement("code");
  code.textContent = "Code";
  setInlineStyles(code, myoxusTextStyles({ code: true }));
  inline.append(code);
  const link = makeLink();
  link.delta = { insert: "Link", attributes: { link: "https://example.com" } };
  content.append(inline, link);
  root.append(content);
  outer.append(style, root);
  document.body.append(outer);
  try {
    const sizes = () =>
      [
        "myoxus-paragraph",
        "myoxus-list",
        ".h2",
        ".doc-title-container",
        ".myoxus-code-block-container",
        "code",
        "a",
      ].map((selector) =>
        parseFloat(getComputedStyle(content.querySelector(selector)!).fontSize),
      );
    expect(sizes()).toEqual([14, 14, 24, 30, 13, 13, 14]);
    root.style.setProperty("--myoxus-document-reading-size", "21px");
    expect(sizes()).toEqual([21, 21, 36, 45, 19.5, 19.5, 21]);
    expect(getComputedStyle(content.querySelector(".h2")!).lineHeight).toBe(
      "45px",
    );
    expect(getComputedStyle(outer).fontSize).toBe("14px");
    outer.style.setProperty("--myoxus-typography-body-size", "21px");
    // The explicit body size survives a different theme base; ratios follow that theme.
    expect(sizes()).toEqual([21, 21, 24, 30, 13, 13, 14]);
    root.style.removeProperty("--myoxus-document-reading-size");
    outer.style.setProperty("--myoxus-typography-body-size", "14px");
    expect(sizes()).toEqual([14, 14, 24, 30, 13, 13, 14]);
    root.dataset.editorMode = "edgeless";
    root.style.setProperty("--myoxus-document-reading-size", "21px");
    expect(sizes()).toEqual([14, 14, 24, 30, 13, 13, 14]);
  } finally {
    outer.remove();
  }
});
