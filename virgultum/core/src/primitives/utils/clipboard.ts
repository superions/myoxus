// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Returns whether text was copied. The gesture fallback preserves DOM focus and ranges. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Browser policy can reject the asynchronous API while allowing a copy gesture.
  }

  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const buffer = document.createElement("textarea");
  buffer.value = text;
  buffer.readOnly = true;
  buffer.tabIndex = -1;
  buffer.setAttribute("aria-hidden", "true");
  Object.assign(buffer.style, {
    position: "fixed",
    opacity: "0",
    pointerEvents: "none",
  });
  try {
    document.body.append(buffer);
    buffer.focus({ preventScroll: true });
    buffer.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    buffer.remove();
    if (focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges)
      if (range.commonAncestorContainer.isConnected) selection?.addRange(range);
  }
}
