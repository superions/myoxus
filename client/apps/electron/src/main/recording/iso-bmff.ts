// SPDX-License-Identifier: AGPL-3.0-or-later

const REQUIRED_TOP_LEVEL_BOXES = ["ftyp", "moov", "mdat"] as const;

function readBoxType(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
}

export function isFinalizedIsoBmff(buffer: Uint8Array): boolean {
  if (buffer.byteLength === 0) {
    return false;
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const foundBoxes = new Set<string>();
  let offset = 0;

  while (offset < view.byteLength) {
    const remaining = view.byteLength - offset;
    if (remaining < 8) {
      return false;
    }

    const size32 = view.getUint32(offset);
    let headerSize = 8;
    let boxSize: number;

    if (size32 === 1) {
      headerSize = 16;
      if (remaining < headerSize) {
        return false;
      }

      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return false;
      }
      boxSize = Number(extendedSize);
    } else {
      boxSize = size32 === 0 ? remaining : size32;
    }

    if (boxSize < headerSize || boxSize > remaining) {
      return false;
    }

    foundBoxes.add(readBoxType(view, offset));
    offset += boxSize;
  }

  return REQUIRED_TOP_LEVEL_BOXES.every((type) => foundBoxes.has(type));
}
