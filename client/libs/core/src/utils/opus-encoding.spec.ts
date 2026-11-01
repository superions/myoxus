// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, test, vi } from "vitest";

import { muxToMp4 } from "./opus-encoding";
import {
  encodedOpusChunks,
  readAudioTrackMetadata,
  SyntheticEncodedAudioChunk,
} from "./opus-encoding.fixtures";

const stereo48Khz = { sampleRate: 48_000, numberOfChannels: 2 };

beforeAll(() => {
  vi.stubGlobal("EncodedAudioChunk", SyntheticEncodedAudioChunk);
});

describe("Opus MP4 muxing", () => {
  test("loads the muxer only for valid work and propagates loading failures", async () => {
    const failure = new Error("Muxer chunk unavailable");
    vi.resetModules();
    vi.doMock("mediabunny", () => {
      throw failure;
    });
    try {
      const { muxToMp4: lazyMux } = await import("./opus-encoding");
      await expect(lazyMux([], stereo48Khz)).rejects.toThrow(
        "at least one encoded audio packet",
      );
      // Vitest wraps factory failures; the rejected import retains the cause.
      await expect(
        lazyMux(encodedOpusChunks(), stereo48Khz),
      ).rejects.toMatchObject({ cause: failure });
    } finally {
      vi.doUnmock("mediabunny");
      vi.resetModules();
    }
  });

  test("finalizes a single mono packet without inventing another track", async () => {
    const output = await muxToMp4(encodedOpusChunks([0]), {
      sampleRate: 48_000,
      numberOfChannels: 1,
    });
    const metadata = readAudioTrackMetadata(output);

    expect(metadata.trackCount).toBe(1);
    expect(metadata.entryCount).toBe(1);
    expect(metadata.codec).toBe("Opus");
    expect(metadata.channels).toBe(1);
    expect(metadata.sampleRate).toBe(48_000);
    expect(metadata.sampleDeltas).toEqual([{ count: 1, delta: 960 }]);
  });

  test("finalizes one Opus audio track with stable timing metadata", async () => {
    const output = await muxToMp4(encodedOpusChunks(), stereo48Khz);
    const metadata = readAudioTrackMetadata(output);

    expect(metadata.boxes.map((box) => box.type)).toEqual([
      "ftyp",
      "moov",
      "mdat",
    ]);
    expect(metadata.trackCount).toBe(1);
    expect(metadata.entryCount).toBe(1);
    expect(metadata.codec).toBe("Opus");
    expect(metadata.channels).toBe(2);
    expect(metadata.sampleRate).toBe(48_000);
    expect(metadata.timescale).toBe(48_000);
    expect(metadata.duration / metadata.timescale).toBeCloseTo(0.06, 5);
    expect(metadata.sampleDeltas).toEqual([{ count: 3, delta: 960 }]);
  });

  test("rejects empty and non-monotone packet sequences", async () => {
    await expect(muxToMp4([], stereo48Khz)).rejects.toThrow(
      "at least one encoded audio packet",
    );
    await expect(
      muxToMp4(encodedOpusChunks([0, 40_000, 20_000]), stereo48Khz),
    ).rejects.toThrow("monotone");
  });
});
