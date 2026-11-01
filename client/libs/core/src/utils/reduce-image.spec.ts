// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateAndReduceImage } from "./reduce-image";

let width = 8000;
let height = 4000;
const decode = vi.fn();
const drawImage = vi.fn();
const encode = vi.fn();
const revoke = vi.fn();
const getContext = vi.fn();

beforeEach(() => {
  width = 8000;
  height = 4000;
  decode.mockResolvedValue(undefined);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      get naturalWidth() {
        return width;
      }
      get naturalHeight() {
        return height;
      }
      decode = decode;
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  getContext.mockReturnValue({ drawImage });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    getContext,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(encode);
  encode.mockImplementation((callback: BlobCallback, mime: string) =>
    callback(new Blob(["encoded"], { type: mime })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("avatar image reduction", () => {
  test("keeps small uploads byte-identical and releases their object URL", async () => {
    width = height = 4000;
    const file = new File(["animation and metadata"], "avatar.gif", {
      type: "image/gif",
    });
    expect(await validateAndReduceImage(file)).toBe(file);
    expect(encode).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:avatar");
  });
  test("preserves aspect ratio and JPEG type while releasing the canvas", async () => {
    const file = new File(["source"], "avatar.jpg", {
      type: "image/jpeg",
      lastModified: 123,
    });
    const result = await validateAndReduceImage(file);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4000, 2000);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe(file.name);
    expect(result.lastModified).toBe(123);
    expect((getContext.mock.contexts[0] as HTMLCanvasElement).width).toBe(0);
    expect(revoke).toHaveBeenCalledOnce();
  });
  test("labels a browser PNG fallback with its actual MIME and extension", async () => {
    encode.mockImplementation((callback: BlobCallback) =>
      callback(new Blob(["png"], { type: "image/png" })),
    );
    const result = await validateAndReduceImage(
      new File(["source"], "avatar.webp", { type: "image/webp" }),
    );
    expect(result.type).toBe("image/png");
    expect(result.name).toBe("avatar.png");
  });
  test("reduces dimensions again when the encoded file exceeds the byte budget", async () => {
    encode.mockImplementationOnce((callback: BlobCallback) =>
      callback(
        new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" }),
      ),
    );
    const result = await validateAndReduceImage(
      new File(["source"], "avatar.png", { type: "image/png" }),
    );
    expect(drawImage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      0,
      0,
      3000,
      1500,
    );
    expect(result.size).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
  test("re-encodes small dimensions when the source exceeds the byte budget", async () => {
    width = height = 100;
    await validateAndReduceImage(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "avatar.png", {
        type: "image/png",
      }),
    );
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100);
  });
  test("rejects decode failures and releases the URL", async () => {
    decode.mockRejectedValue(new Error("invalid"));
    await expect(
      validateAndReduceImage(new File(["broken"], "avatar.png")),
    ).rejects.toThrow("Image could not be decoded");
    expect(revoke).toHaveBeenCalledOnce();
    expect(encode).not.toHaveBeenCalled();
  });
  test("rejects encoder failure and releases both resources", async () => {
    encode.mockImplementation((callback: BlobCallback) => callback(null));
    await expect(
      validateAndReduceImage(new File(["source"], "avatar.png")),
    ).rejects.toThrow("Image processing failed");
    expect(revoke).toHaveBeenCalledOnce();
    expect((getContext.mock.contexts[0] as HTMLCanvasElement).width).toBe(0);
  });
});
