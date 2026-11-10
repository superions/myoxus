import type { Page } from "@playwright/test";

/**
 * @example
 * ```ts
 * const codeBlockController = getCodeBlock(page);
 * const codeBlock = codeBlockController.codeBlock;
 * ```
 */
export function getCodeBlock(page: Page) {
  const codeBlock = page.locator("myoxus-code");
  const languageButton = page.getByTestId("lang-button");

  const clickLanguageButton = async () => {
    await codeBlock.hover();
    await languageButton.click({ delay: 50 });
  };

  const langList = page.getByRole("listbox");
  const langFilterInput = languageButton;

  const codeToolbar = page.getByTestId("code-toolbar");

  const copyButton = codeToolbar.getByRole("button", { name: "Copy code" });
  const captionButton = codeToolbar.getByRole("button", { name: "Caption" });
  const moreButton = codeToolbar.getByRole("button", { name: "More" });

  const menu = page.getByRole("menu");

  const openMore = async () => {
    await moreButton.click();

    const wrapButton = menu.getByRole("menuitem", { name: "Wrap lines" });
    const cancelWrapButton = menu.getByRole("menuitem", { name: "Wrap lines" });
    const duplicateButton = menu.getByRole("menuitem", { name: "Duplicate" });
    const deleteButton = menu.getByRole("menuitem", { name: "Delete" });
    const lineNumberButton = menu.getByRole("menuitem", {
      name: "Line numbers",
    });
    const cancelLineNumberButton = menu.getByRole("menuitem", {
      name: "Line numbers",
    });

    return {
      menu,
      wrapButton,
      cancelWrapButton,
      duplicateButton,
      deleteButton,
      lineNumberButton,
      cancelLineNumberButton,
    };
  };

  return {
    codeBlock,
    codeToolbar,
    captionButton,
    languageButton,
    langList,
    copyButton,
    moreButton,
    langFilterInput,
    moreMenu: menu,

    openMore,
    clickLanguageButton,
  };
}
