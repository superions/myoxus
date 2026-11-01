import { VirgultumError } from "@virgultum/global/exceptions";
import { describe, expect, test } from "vitest";

import { getAssetName } from "../adapter/assets.js";
import { AssetsManager } from "../transformer/assets.js";

const malformedAsf = Uint8Array.from([
  0x31, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00,
  0x62, 0xce, 0x00,
]);

const claimedZipBomb = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
  0x01, 0x00, 0x00, 0x00, 0x61, 0x00,
]);

describe("getAssetName", () => {
  test("should return the name if it exists", () => {
    const assets = new Map<string, Blob>([
      ["blobId", new File([], "image.png", { type: "image/png" })],
      ["blobId2", new File([], "image", { type: "image/png" })],
      // inconsistent name with type
      ["blobId3", new File([], "image.jpg", { type: "image/png" })],
      // empty name
      ["blobId4", new File([], "", { type: "image/png" })],
    ]);
    expect(getAssetName(assets, "blobId")).toBe("image.png");
    expect(getAssetName(assets, "blobId2")).toBe("image.png");
    // respect the original name
    expect(getAssetName(assets, "blobId3")).toBe("image.jpg");
    expect(getAssetName(assets, "blobId4")).toBe("blobId4.png");
  });

  test("should return blobId with extension if name does not exist", () => {
    const assets = new Map<string, Blob>([
      ["blobId", new Blob([], { type: "image/jpeg" })],
    ]);
    const result = getAssetName(assets, "blobId");
    expect(result).toBe("blobId.jpeg");
  });

  test("should return the name if it exists but type is empty", () => {
    const assets = new Map<string, Blob>([
      ["blobId", new File([], "document.test", { type: "" })],
    ]);
    const result = getAssetName(assets, "blobId");
    expect(result).toBe("document.test");
  });

  test("should return the original name even not ext found", () => {
    const assets = new Map<string, Blob>([["blobId", new File([], "blob.")]]);
    const result = getAssetName(assets, "blobId");
    expect(result).toBe("blob.");
  });

  test('should return blobId with "blob" extension if type is empty', () => {
    const assets = new Map<string, Blob>([
      ["blobId", new Blob([])],
      ["blobId2", new Blob([], { type: "" })],
    ]);
    expect(getAssetName(assets, "blobId")).toBe("blobId.blob");
    expect(getAssetName(assets, "blobId2")).toBe("blobId2.blob");
  });

  test("should return blobId with last part of mime type if extension is not found", () => {
    const assets = new Map<string, Blob>([
      ["blobId", new Blob([], { type: "application/unknown" })],
    ]);
    const result = getAssetName(assets, "blobId");
    expect(result).toBe("blobId.unknown");
  });

  test("should return blobId with bin if type is octet-stream", () => {
    const assets = new Map<string, Blob>([
      ["blobId", new Blob([], { type: "application/octet-stream" })],
    ]);
    const result = getAssetName(assets, "blobId");
    expect(result).toBe("blobId.bin");
  });

  test("should throw VirgultumError if blob is not found", () => {
    const assets = new Map<string, Blob>();
    expect(() => getAssetName(assets, "blobId")).toThrow(VirgultumError);
    expect(() => getAssetName(assets, "blobId")).toThrowError(
      "blob not found for blobId: blobId",
    );
  });
});

describe("AssetsManager file type boundary", () => {
  function managerFor(blob: Blob) {
    return new AssetsManager({
      blob: {
        delete: async () => {},
        get: async () => blob,
        list: async () => [],
        set: async () => "blob-id",
      },
    });
  }

  test("keeps a malformed ASF envelope opaque instead of misclassifying it", async () => {
    const manager = managerFor(
      new Blob([malformedAsf], { type: "application/octet-stream" }),
    );

    await manager.readFromBlob("asf");

    const stored = manager.getAssets().get("asf");
    expect(stored?.type).toBe("application/octet-stream");
    expect(stored?.size).toBe(malformedAsf.byteLength);
  });

  test("retains only the original ZIP bytes after type detection", async () => {
    const manager = managerFor(
      new Blob([claimedZipBomb], { type: "application/octet-stream" }),
    );

    await manager.readFromBlob("zip");

    const stored = manager.getAssets().get("zip");
    expect(stored?.type).toBe("application/zip");
    expect(stored?.size).toBe(claimedZipBomb.byteLength);
  });
});
