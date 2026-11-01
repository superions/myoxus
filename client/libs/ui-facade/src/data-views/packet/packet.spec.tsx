// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MyoxusUIProvider } from "../../provider";
import { PacketBitGrid } from "./index";

afterEach(cleanup);

describe("PacketBitGrid", () => {
  test("projects inclusive ranges into proportional grid spans and selection", () => {
    const onSelectField = vi.fn();
    const preview = vi.fn(),
      confirm = vi.fn(),
      cancel = vi.fn();
    const { container } = render(
      <MyoxusUIProvider>
        <PacketBitGrid
          aria-label="Network packet"
          rows={[
            {
              row: 0,
              startBit: 0,
              endBit: 11,
              fragments: [
                {
                  fieldId: "version",
                  label: "Version",
                  row: 0,
                  columnStart: 0,
                  columnEnd: 3,
                  startBit: 0,
                  endBit: 3,
                  fieldStartBit: 0,
                  fieldEndBit: 3,
                  continuesBefore: false,
                  continuesAfter: false,
                  boundary: {
                    leftKey: "version",
                    rightKey: "length",
                    bit: 4,
                    min: 1,
                    max: 11,
                  },
                },
                {
                  fieldId: "length",
                  label: "Length",
                  row: 0,
                  columnStart: 4,
                  columnEnd: 11,
                  startBit: 4,
                  endBit: 11,
                  fieldStartBit: 4,
                  fieldEndBit: 11,
                  continuesBefore: false,
                  continuesAfter: false,
                },
              ],
            },
          ]}
          bitsPerRow={16}
          bitWidth={24}
          rowHeight={32}
          paddingX={5}
          paddingY={15}
          showBits
          fieldOrder={["version", "length"]}
          labels={{
            field: (label, start, end) => `${label}: Bits ${start}–${end}`,
            boundary: (bit, label) => `${bit} ${label}`,
            reorderTarget: (index) => String(index),
            totalWidth: (bits) => `${bits} bits`,
          }}
          selectedFieldId="length"
          onGeometryPreview={preview}
          onGeometryConfirm={confirm}
          onGeometryCancel={cancel}
          onSelectField={onSelectField}
          totalWidth={12}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("12 bits")).toBeInstanceOf(HTMLElement);
    const fields = container.querySelectorAll<HTMLElement>(
      '[data-myoxus-ui-role="packet-bit-field-shell"]',
    );
    expect(fields[0].style.getPropertyValue("--packet-grid-width")).toBe("4");
    expect(fields[1].style.getPropertyValue("--packet-grid-width")).toBe("8");
    fireEvent.click(screen.getByRole("button", { name: /Length/ }));
    expect(onSelectField).toHaveBeenCalledWith(
      "length",
      expect.any(HTMLButtonElement),
    );
    const boundary = screen.getByRole("button", {
      name: "4 Version",
    });
    fireEvent.keyDown(boundary, { key: "ArrowRight" });
    expect(preview).toHaveBeenLastCalledWith({
      kind: "boundary",
      leftKey: "version",
      rightKey: "length",
      bit: 5,
    });
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(boundary, { key: "Escape" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(boundary, { key: "ArrowRight" });
    fireEvent.keyDown(boundary, { key: "Enter" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith({
      kind: "boundary",
      leftKey: "version",
      rightKey: "length",
      bit: 5,
    });
    fireEvent.keyDown(boundary, { key: "Enter" });
    expect(confirm).toHaveBeenCalledOnce();
  });
});
