// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import type { NativeImage } from "electron";
import { beforeEach, describe, expect, test, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  write: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: { write: electronMocks.write },
  ClipboardItem: class ClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  },
  nativeImage: { createFromBuffer: electronMocks.createFromBuffer },
}));

import { writePngToClipboard } from "../../src/main/clipboard";

describe("Electron 44 clipboard integration", () => {
  beforeEach(() => {
    electronMocks.createFromBuffer.mockReset();
    electronMocks.write.mockReset();
  });

  test("writes PNG bytes through a MIME-typed ClipboardItem and awaits the commit", async () => {
    let finishWrite!: () => void;
    electronMocks.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const image = { toPNG: vi.fn(() => png) };
    let settled = false;

    const writing = writePngToClipboard(image as NativeImage).then(() => {
      settled = true;
    });

    expect(image.toPNG).toHaveBeenCalledOnce();
    expect(electronMocks.write).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    const [items] = electronMocks.write.mock.calls[0] as [
      Array<{ items: Record<string, Blob> }>,
    ];
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0].items)).toEqual(["image/png"]);
    const blob = items[0].items["image/png"];
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...png]);

    finishWrite();
    await writing;
    expect(settled).toBe(true);
  });
});
