import { type Clipboard as BlockStdScopeClipboard } from "@virgultum/editor/std";

import { copyTextToClipboard } from "@virgultum/core/primitives/utils";
export { copyTextToClipboard } from "@virgultum/core/primitives/utils";

export const copyEditorLink = async (
  text: string,
  clipboard?: Pick<BlockStdScopeClipboard, "writeToClipboard">,
) => {
  let success = false;

  if (typeof navigator.clipboard?.write === "function") {
    try {
      const write = clipboard
        ? clipboard.writeToClipboard.bind(clipboard)
        : (await import("@virgultum/core/runtime")).writeClipboardItems;
      await write((items) => ({
        ...items,
        "text/plain": text,
        // wrap a link
        "text/html": `<a href="${text}">${text}</a>`,
      }));
      success = true;
    } catch (error) {
      console.error(error);
    }
  }

  if (!success) {
    success = await copyTextToClipboard(text);
  }

  return success;
};
