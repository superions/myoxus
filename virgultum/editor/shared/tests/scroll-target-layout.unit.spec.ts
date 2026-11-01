// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal } from "@preact/signals-core";
import { HighlightSelection } from "@virgultum/shared/selection";
import type { BlockStdScope } from "@virgultum/std";
import { Subject } from "rxjs";
import { expect, test } from "vitest";

import { MyoxusScrollAnchoringWidget } from "../../widgets/scroll-anchoring/src/scroll-anchoring.js";

class TargetLayoutWidget extends MyoxusScrollAnchoringWidget {
  fixtureStd!: BlockStdScope;

  override get std() {
    return this.fixtureStd;
  }

  override handleEvent = () => {};
}

customElements.define("target-layout-widget", TargetLayoutWidget);

test("keeps the actual target highlight aligned when external title layout moves an unchanged editor", async () => {
  const viewport = document.createElement("div");
  viewport.style.cssText = "position: relative; border: 3px solid;";
  const title = document.createElement("div");
  title.style.height = "56px";
  const host = document.createElement("div");
  host.style.height = "120px";
  const target = document.createElement("div");
  target.textContent = "Über Größe";
  target.style.cssText = "height: 36px; margin-inline: 20px;";
  host.append(target);
  const blockUpdated = new Subject();
  const viewUpdated = new Subject();
  const selection = signal<HighlightSelection | undefined>(undefined);
  let mounted = false;
  const widget = new TargetLayoutWidget();
  widget.fixtureStd = {
    host,
    view: {
      setWidget() {},
      deleteWidget() {},
      getBlock: () => (mounted ? target : null),
      viewUpdated,
    },
    store: { slots: { blockUpdated } },
    selection: {
      find: () => selection.value,
      clear: () => {
        selection.value = undefined;
      },
    },
    get: () => ({ viewport: { viewportUpdated: new Subject() } }),
  } as unknown as BlockStdScope;
  viewport.append(title, host, widget);
  document.body.append(viewport);
  try {
    await widget.updateComplete;
    selection.value = new HighlightSelection({
      mode: "page",
      blockIds: ["heading"],
      highlight: true,
    });
    await widget.updateComplete;
    expect(widget.shadowRoot!.querySelector(".highlight")).toBeNull();
    mounted = true;
    viewUpdated.next({ type: "block", method: "add", id: "heading" });
    await widget.updateComplete;
    const highlight = widget.shadowRoot!.querySelector(".highlight")!;
    const aligned = () => {
      const actual = highlight.getBoundingClientRect();
      const expected = target.getBoundingClientRect();
      expect(actual.left).toBeCloseTo(expected.left, 1);
      expect(actual.top).toBeCloseTo(expected.top, 1);
      expect(actual.width).toBeCloseTo(expected.width, 1);
      expect(actual.height).toBeCloseTo(expected.height, 1);
    };
    aligned();
    const unchangedHostHeight = host.getBoundingClientRect().height;
    title.style.height = "78px";
    // Wait for the native ResizeObserver and Lit render, not a manual refresh.
    await expect
      .poll(() => highlight.getBoundingClientRect().top)
      .toBe(target.getBoundingClientRect().top);
    expect(host.getBoundingClientRect().height).toBe(unchangedHostHeight);
    aligned();
    const precedingBlock = document.createElement("div");
    precedingBlock.style.height = "24px";
    host.prepend(precedingBlock);
    blockUpdated.next({ type: "update", id: "note" });
    await expect
      .poll(() => highlight.getBoundingClientRect().top)
      .toBe(target.getBoundingClientRect().top);
    expect(host.getBoundingClientRect().height).toBe(unchangedHostHeight);
    aligned();
  } finally {
    viewport.remove();
  }
}, 5000);
