// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import * as Y from "yjs";

/** Preserve IME ownership and rebase both selection endpoints while peers edit.
 * The caller verifies that this text is still attached at its native address. */
export function bindPageTextarea(
  el: HTMLTextAreaElement,
  text: Y.Text,
  store: Store,
  attached: () => boolean,
) {
  const doc = store.spaceDoc;
  const range = () =>
    [el.selectionStart, el.selectionEnd].map((i) =>
      Y.createRelativePositionFromTypeIndex(text, i, -1),
    );
  let selection: Y.RelativePosition[] | undefined,
    composition: Y.RelativePosition[] | undefined;
  const resolve = (r: Y.RelativePosition[]) =>
    r.map((p) => Y.createAbsolutePositionFromRelativePosition(p, doc)?.index);
  const before = () => {
    if (!composition && document.activeElement === el) selection = range();
  };
  const paint = () => {
    if (composition) return;
    const value = text.toString();
    if (el.value !== value) el.value = value;
    if (selection && document.activeElement === el) {
      const [a, b] = resolve(selection);
      if (a !== undefined && b !== undefined) el.setSelectionRange(a, b);
    }
    selection = undefined;
  };
  const replace = (start: number, end: number, value: string) => {
    if (el.readOnly || !el.isConnected || store.readonly || !attached()) return;
    store.transact(() => {
      if (end > start) text.delete(start, end - start);
      if (value) text.insert(start, value);
    });
    el.setSelectionRange(start + value.length, start + value.length);
  };
  let inputRange: [number, number] | undefined;
  const capture = () => {
    inputRange = [el.selectionStart, el.selectionEnd];
  };
  const input = () => {
    if (composition) return;
    const old = text.toString(),
      value = el.value;
    if (old === value) return;
    let start = 0,
      end = old.length,
      next = value.length;
    // The live range disambiguates edits among identical characters. Retain a
    // minimal diff for replacements whose native target extends past the caret.
    const [a, b] = inputRange ?? [old.length, 0];
    inputRange = undefined;
    while (
      start < end &&
      start < next &&
      start < a &&
      old[start] === value[start]
    )
      start++;
    while (
      end > start &&
      end > b &&
      next > start &&
      old[end - 1] === value[next - 1]
    ) {
      end--;
      next--;
    }
    replace(start, end, value.slice(start, next));
  };
  const begin = () => {
    composition = range();
  };
  const finish = (e: CompositionEvent) => {
    if (!composition) return;
    const [a, b] = resolve(composition);
    composition = undefined;
    if (a !== undefined && b !== undefined && e.data) replace(a, b, e.data);
    paint();
  };
  const abort = new AbortController(),
    opts = { signal: abort.signal };
  paint();
  doc.on("beforeAllTransactions", before);
  text.observe(paint);
  el.addEventListener("beforeinput", capture, opts);
  el.addEventListener("input", input, opts);
  el.addEventListener("compositionstart", begin, opts);
  el.addEventListener("compositionend", finish, opts);
  return () => {
    abort.abort();
    doc.off("beforeAllTransactions", before);
    text.unobserve(paint);
  };
}
