import { afterEach, describe, expect, it, vi } from "vitest";

import { resourceUrlToBlob } from "./resource";

const asfHeader = Uint8Array.from([
  0x31, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00,
  0x62, 0xce, 0x00,
]);

// The local header claims a 4 GiB uncompressed member but carries one byte.
// File type detection must inspect the envelope, never inflate its contents.
const claimedZipBomb = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
  0x01, 0x00, 0x00, 0x00, 0x61, 0x00,
]);

function mockResource(bytes: Uint8Array) {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const fetchMock = vi.fn(async () => new Response(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resource file type boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails closed for a malformed ASF envelope", async () => {
    const fetchMock = mockResource(asfHeader);

    await expect(
      resourceUrlToBlob("https://example.test/malformed.asf"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies a hostile ZIP header without expanding its payload", async () => {
    mockResource(claimedZipBomb);

    const blob = await resourceUrlToBlob("https://example.test/archive.zip");

    expect(blob?.type).toBe("application/zip");
    expect(blob?.size).toBe(claimedZipBomb.byteLength);
  });
});
