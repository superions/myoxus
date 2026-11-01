// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Popover, PopoverContent, PopoverTarget } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => cleanup());

describe("Facade PopoverContent", () => {
  test.each([undefined, false])(
    "forwards dropdown interaction boundaries with withinPortal=%s",
    (withinPortal) => {
      const onClick = vi.fn();
      const onKeyDown = vi.fn();
      const onPointerDown = vi.fn();

      const { container } = render(
        <MyoxusUIProvider>
          <Popover
            opened
            withArrow
            contentMeasure="reading"
            withinPortal={withinPortal}
          >
            <PopoverTarget>
              <button type="button" data-myoxus-ui-role="packet-bit-field">
                Trigger
              </button>
            </PopoverTarget>
            <PopoverContent
              onClick={onClick}
              onKeyDown={onKeyDown}
              onPointerDown={onPointerDown}
            >
              <button type="button">Inside</button>
            </PopoverContent>
          </Popover>
        </MyoxusUIProvider>,
      );

      expect(
        screen
          .getByRole("button", { name: "Trigger" })
          .getAttribute("data-myoxus-ui-role"),
      ).toBe("packet-bit-field");
      const content = screen
        .getByRole("button", { name: "Inside" })
        .closest('[data-myoxus-ui-role="popover-content"]');
      expect(container.contains(content)).toBe(withinPortal === false);

      fireEvent.click(content!);
      fireEvent.keyDown(content!, { key: "Escape" });
      fireEvent.pointerDown(content!);

      expect(onClick).toHaveBeenCalledOnce();
      expect(onKeyDown).toHaveBeenCalledOnce();
      expect(onPointerDown).toHaveBeenCalledOnce();
    },
  );
});
