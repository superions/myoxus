// SPDX-License-Identifier: AGPL-3.0-or-later
/** During the DOM swap the browser may target the body or the receiver before
 * its range is restored. Hold printable input in order until the receiving
 * command owns focus. Other documents and unrelated controls keep their input. */
export function holdPageText(docId: string, write?: (text: string) => boolean) {
  const pending: string[] = [];
  const events = new AbortController();
  const owns = (target: EventTarget | null) =>
    target === document.body ||
    (target instanceof Element &&
      target.closest(`[data-testid="editor-${CSS.escape(docId)}"]`));
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !owns(event.target) ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.length !== 1
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!write?.(event.key)) pending.push(event.key);
    },
    { capture: true, signal: events.signal },
  );
  window.addEventListener(
    "beforeinput",
    (event) => {
      if (
        !owns(event.target) ||
        event.isComposing ||
        !event.data ||
        event.inputType !== "insertText"
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!write?.(event.data)) pending.push(event.data);
    },
    { capture: true, signal: events.signal },
  );
  return {
    release: () => {
      events.abort();
      return pending.splice(0).join("");
    },
  };
}
