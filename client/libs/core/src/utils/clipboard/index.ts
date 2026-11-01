import { type Clipboard as BlockStdScopeClipboard } from "@virgultum/editor/std";

import { copyTextToClipboard } from "@virgultum/global/utils";
export { copyTextToClipboard } from "@virgultum/global/utils";

export const copyLinkToBlockStdScopeClipboard = async (
  text: string,
  clipboard?: BlockStdScopeClipboard,
) => {
  let success = false;

  if (!clipboard) return success;

  if (typeof navigator.clipboard?.write === "function") {
    try {
      await clipboard.writeToClipboard((items) => ({
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
