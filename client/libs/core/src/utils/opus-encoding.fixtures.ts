// SPDX-License-Identifier: AGPL-3.0-or-later

export type IsoBox = {
  type: string;
  start: number;
  end: number;
  dataStart: number;
  children: IsoBox[];
};

const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "dinf",
  "edts",
  "udta",
]);

function readType(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function parseBoxRange(bytes: Uint8Array, start: number, end: number) {
  const boxes: IsoBox[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;

  while (offset < end) {
    if (end - offset < 8) throw new Error("Truncated ISO-BMFF box header");
    const size32 = view.getUint32(offset);
    const type = readType(bytes, offset + 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) throw new Error("Truncated large ISO-BMFF box");
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      throw new Error(`Invalid ISO-BMFF box size for ${type}`);
    }

    const dataStart = offset + headerSize;
    const boxEnd = offset + size;
    boxes.push({
      type,
      start: offset,
      end: boxEnd,
      dataStart,
      children: CONTAINER_BOXES.has(type)
        ? parseBoxRange(bytes, dataStart, boxEnd)
        : [],
    });
    offset = boxEnd;
  }

  return boxes;
}

export function parseIsoBmff(bytes: Uint8Array) {
  return parseBoxRange(bytes, 0, bytes.byteLength);
}

export function findIsoBoxes(boxes: IsoBox[], type: string): IsoBox[] {
  return boxes.flatMap((box) => [
    ...(box.type === type ? [box] : []),
    ...findIsoBoxes(box.children, type),
  ]);
}

export function readAudioTrackMetadata(bytes: Uint8Array) {
  const boxes = parseIsoBmff(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mdhd = findIsoBoxes(boxes, "mdhd")[0];
  const stsd = findIsoBoxes(boxes, "stsd")[0];
  const stts = findIsoBoxes(boxes, "stts")[0];
  if (!mdhd || !stsd || !stts) {
    throw new Error("MP4 audio metadata boxes are incomplete");
  }

  const mdhdVersion = bytes[mdhd.dataStart];
  const timescaleOffset = mdhd.dataStart + (mdhdVersion === 1 ? 20 : 12);
  const durationOffset = timescaleOffset + 4;
  const timescale = view.getUint32(timescaleOffset);
  const duration =
    mdhdVersion === 1
      ? Number(view.getBigUint64(durationOffset))
      : view.getUint32(durationOffset);

  const entryCount = view.getUint32(stsd.dataStart + 4);
  const sampleEntry = stsd.dataStart + 8;
  const codec = readType(bytes, sampleEntry + 4);
  const channels = view.getUint16(sampleEntry + 24);
  const sampleRate = view.getUint32(sampleEntry + 32) >>> 16;

  const timingEntryCount = view.getUint32(stts.dataStart + 4);
  const sampleDeltas: Array<{ count: number; delta: number }> = [];
  for (let index = 0; index < timingEntryCount; index++) {
    const entryOffset = stts.dataStart + 8 + index * 8;
    sampleDeltas.push({
      count: view.getUint32(entryOffset),
      delta: view.getUint32(entryOffset + 4),
    });
  }

  return {
    boxes,
    channels,
    codec,
    duration,
    entryCount,
    sampleDeltas,
    sampleRate,
    timescale,
    trackCount: findIsoBoxes(boxes, "trak").length,
  };
}

export class SyntheticEncodedAudioChunk {
  readonly byteLength: number;

  constructor(
    private readonly data: Uint8Array,
    readonly timestamp: number,
    readonly duration: number,
    readonly type: EncodedAudioChunkType = "key",
  ) {
    this.byteLength = data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource) {
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(
          destination.buffer,
          destination.byteOffset,
          destination.byteLength,
        )
      : new Uint8Array(destination);
    bytes.set(this.data);
  }
}

export function encodedOpusChunks(
  timestamps = [0, 20_000, 40_000],
): EncodedAudioChunk[] {
  return timestamps.map(
    (timestamp, index) =>
      new SyntheticEncodedAudioChunk(
        new Uint8Array([0xf8, 0xff, 0xfe, index]),
        timestamp,
        20_000,
      ) as unknown as EncodedAudioChunk,
  );
}
