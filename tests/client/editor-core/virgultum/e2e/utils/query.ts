import { expect, type Locator, type Page } from "@playwright/test";

import { waitNextFrame } from "./actions/misc.js";
import { assertAlmostEqual } from "./asserts.js";

export function getFormatBar(page: Page) {
  const formatBar = page.getByTestId("selection-toolbar");
  const boldBtn = formatBar.getByTestId("bold");
  const italicBtn = formatBar.getByTestId("italic");
  const underlineBtn = formatBar.getByTestId("underline");
  const strikeBtn = formatBar.getByTestId("strike");
  const codeBtn = formatBar.getByTestId("code");
  const linkBtn = formatBar.getByTestId("link");
  // highlight
  const highlightBtn = formatBar.getByRole("button", {
    name: "Highlight",
    exact: true,
  });
  const openMenu = async (button: Locator) => {
    if ((await button.getAttribute("aria-expanded")) !== "true")
      await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
  };
  const highlight = {
    highlightBtn,
    openHighlightMenu: () => openMenu(highlightBtn),
    chooseRedBackground: async () => {
      await formatBar
        .getByRole("menuitem", { name: "Background", exact: true })
        .hover();
      await formatBar
        .getByRole("menuitem", { name: "Red", exact: true })
        .click();
    },
  };
  const createLinkedDocBtn = formatBar.getByTestId("convert-to-linked-doc");
  const paragraphBtn = formatBar.getByRole("button", {
    name: "Conversions",
    exact: true,
  });
  const openParagraphMenu = () => openMenu(paragraphBtn);
  const textBtn = formatBar.getByRole("menuitem", {
    name: "Text",
    exact: true,
  });
  const h1Btn = formatBar.getByRole("menuitem", {
    name: "Heading #1",
    exact: true,
  });
  const bulletedBtn = formatBar.getByRole("menuitem", {
    name: "Bulleted List",
    exact: true,
  });
  const codeBlockBtn = formatBar.getByRole("menuitem", {
    name: "Code Block",
    exact: true,
  });
  const moreBtn = formatBar.getByRole("button", { name: "More", exact: true });
  const copyBtn = formatBar.getByRole("menuitem", {
    name: "Copy",
    exact: true,
  });
  const duplicateBtn = formatBar.getByRole("menuitem", {
    name: "Duplicate",
    exact: true,
  });
  const deleteBtn = formatBar.getByRole("menuitem", {
    name: "Delete",
    exact: true,
  });
  const openMoreMenu = () => openMenu(moreBtn);

  const assertBoundingBox = async (x: number, y: number) => {
    const boundingBox = await formatBar.boundingBox();
    if (!boundingBox) {
      throw new Error("formatBar doesn't exist");
    }
    assertAlmostEqual(boundingBox.x, x, 6);
    assertAlmostEqual(boundingBox.y, y, 6);
  };

  return {
    formatBar,
    boldBtn,
    italicBtn,
    underlineBtn,
    strikeBtn,
    codeBtn,
    linkBtn,
    highlight,
    createLinkedDocBtn,

    openParagraphMenu,
    textBtn,
    h1Btn,
    bulletedBtn,
    codeBlockBtn,

    moreBtn,
    openMoreMenu,
    copyBtn,
    duplicateBtn,
    deleteBtn,

    assertBoundingBox,
  };
}

export function getEmbedCardToolbar(page: Page) {
  const embedCardToolbar = page.getByTestId("selection-toolbar");
  const copyButton = embedCardToolbar.getByRole("button", {
    name: "Copy link",
    exact: true,
  });
  const editButton = embedCardToolbar.getByRole("button", {
    name: "Edit",
    exact: true,
  });
  const cardStyleButton = embedCardToolbar.getByRole("combobox", {
    name: "Card style",
    exact: true,
  });
  const captionButton = embedCardToolbar.getByRole("button", {
    name: "Caption",
    exact: true,
  });
  const moreButton = embedCardToolbar.getByRole("button", {
    name: "More",
    exact: true,
  });
  const cardStyleHorizontalButton = page.getByRole("option", {
    name: "Large horizontal style",
    exact: true,
  });
  const cardStyleListButton = page.getByRole("option", {
    name: "Small horizontal style",
    exact: true,
  });

  const openCardStyleMenu = async () => {
    await expect(embedCardToolbar).toBeVisible();
    await cardStyleButton.click();
    await waitNextFrame(page);
  };

  const openMoreMenu = async () => {
    await expect(embedCardToolbar).toBeVisible();
    await moreButton.click();
    await waitNextFrame(page);
  };

  return {
    embedCardToolbar,
    copyButton,
    editButton,
    cardStyleButton,
    captionButton,
    moreButton,
    openCardStyleMenu,
    openMoreMenu,
    cardStyleHorizontalButton,
    cardStyleListButton,
  };
}
