// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal } from "@preact/signals-core";
import { render } from "lit";
import { describe, expect, test, vi } from "vitest";

import { ImageBlockPageComponent } from "../components/page-image-block";
import type { ImageBlockComponent } from "../image-block";

vi.unstubAllGlobals();
customElements.define("myoxus-image-geometry-test", ImageBlockPageComponent);

describe("decoded page-image geometry", () => {
  test.each([
    { width: 0, height: 0, expected: "150px" },
    { width: 320, height: 160, expected: "320px" },
  ])(
    "renders decoded width without editing authored dimensions: $width",
    ({ width, height, expected }) => {
      const component = new ImageBlockPageComponent();
      const props = Object.freeze({
        width,
        height,
        caption$: signal("Vault image"),
      });
      component.block = {
        model: { props },
        resizeable$: signal(false),
        blobUrl: "blob:test",
        isCommentHighlighted: false,
      } as unknown as ImageBlockComponent;
      component.state = { loading: false } as ImageBlockPageComponent["state"];
      const container = document.createElement("div");
      render(component.render(), container, { host: component });
      const image = container.querySelector("img")!;
      Object.defineProperty(image, "naturalWidth", { value: 150 });
      image.dispatchEvent(new Event("load"));
      render(component.render(), container, { host: component });
      expect(
        container.querySelector<HTMLElement>(".resizable-img")!.style.width,
      ).toBe(expected);
      expect(props.width).toBe(width);
      expect(props.height).toBe(height);
      render(null, container);
    },
  );
});
