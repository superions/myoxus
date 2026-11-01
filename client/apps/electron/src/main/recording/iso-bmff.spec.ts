// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { isFinalizedIsoBmff } from "./iso-bmff";

function concatenate(...parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, payload = new Uint8Array()) {
  const result = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength);
  for (let index = 0; index < 4; index++) {
    view.setUint8(4 + index, type.charCodeAt(index));
  }
  result.set(payload, 8);
  return result;
}

function validRecording() {
  return concatenate(
    box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])),
    box("moov"),
    box("mdat", new Uint8Array([1, 2, 3, 4])),
  );
}

describe("isFinalizedIsoBmff", () => {
  test("accepts a bounded recording with the required top-level boxes", () => {
    expect(isFinalizedIsoBmff(validRecording())).toBe(true);
  });

  test("rejects empty output", () => {
    expect(isFinalizedIsoBmff(new Uint8Array())).toBe(false);
  });

  test.each([
    ["partial box header", validRecording().subarray(0, 7)],
    [
      "box payload shorter than its declared size",
      validRecording().subarray(0, validRecording().byteLength - 1),
    ],
    [
      "partial extended-size header",
      new Uint8Array([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]),
    ],
  ])("rejects truncated output: %s", (_, recording) => {
    expect(isFinalizedIsoBmff(recording)).toBe(false);
  });

  test.each([
    ["smaller than its standard header", 4],
    ["larger than the remaining buffer", 0xffff],
  ])("rejects a box size %s", (_, declaredSize) => {
    const recording = validRecording();
    new DataView(
      recording.buffer,
      recording.byteOffset,
      recording.byteLength,
    ).setUint32(0, declaredSize);

    expect(isFinalizedIsoBmff(recording)).toBe(false);
  });

  test("rejects an extended size smaller than its extended header", () => {
    const malformed = new Uint8Array(16);
    const view = new DataView(malformed.buffer);
    view.setUint32(0, 1);
    view.setUint32(4, 0x66747970);
    view.setBigUint64(8, 8n);

    expect(isFinalizedIsoBmff(malformed)).toBe(false);
  });

  test.each(["ftyp", "moov", "mdat"])(
    "rejects output missing the %s box",
    (missingType) => {
      const recording = concatenate(
        ...["ftyp", "moov", "mdat"]
          .filter((type) => type !== missingType)
          .map((type) => box(type)),
      );

      expect(isFinalizedIsoBmff(recording)).toBe(false);
    },
  );
});
