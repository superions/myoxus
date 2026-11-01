// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  readAudioTrackMetadata,
  SyntheticEncodedAudioChunk,
} from "./opus-encoding.fixtures";

const bridge = vi.hoisted(() => ({
  getRawAudioBuffers: vi.fn(),
}));

vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: () => ({
    apis: {
      recording: {
        getRawAudioBuffers: bridge.getRawAudioBuffers,
      },
    },
  }),
}));

class TestAudioData {
  static instances: TestAudioData[] = [];

  readonly numberOfFrames: number;
  readonly timestamp: number;
  closed = false;

  constructor(init: AudioDataInit) {
    this.numberOfFrames = init.numberOfFrames;
    this.timestamp = init.timestamp;
    TestAudioData.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

class TestAudioEncoder {
  static instances: TestAudioEncoder[] = [];
  static failOnFlush = false;

  state: CodecState = "unconfigured";
  flushCount = 0;
  private readonly pending: TestAudioData[] = [];

  constructor(private readonly init: AudioEncoderInit) {
    TestAudioEncoder.instances.push(this);
  }

  configure() {
    this.state = "configured";
  }

  encode(data: AudioData) {
    this.pending.push(data as unknown as TestAudioData);
  }

  async flush() {
    this.flushCount++;
    if (TestAudioEncoder.failOnFlush) {
      this.init.error(new DOMException("synthetic encoder failure"));
      return;
    }
    for (const [index, frame] of this.pending.splice(0).entries()) {
      this.init.output(
        new SyntheticEncodedAudioChunk(
          new Uint8Array([0xf8, 0xff, 0xfe, index]),
          frame.timestamp,
          (frame.numberOfFrames * 1_000_000) / 48_000,
        ) as unknown as EncodedAudioChunk,
        {},
      );
    }
  }

  close() {
    this.state = "closed";
  }
}

function rawFrames(numberOfFrames: number, channels = 2) {
  return new Uint8Array(new Float32Array(numberOfFrames * channels).buffer);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  bridge.getRawAudioBuffers.mockReset();
  TestAudioData.instances = [];
  TestAudioEncoder.instances = [];
  TestAudioEncoder.failOnFlush = false;
  vi.stubGlobal("AudioData", TestAudioData);
  vi.stubGlobal("AudioEncoder", TestAudioEncoder);
  vi.stubGlobal("EncodedAudioChunk", SyntheticEncodedAudioChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streaming Opus MP4 encoding", () => {
  test("serializes a polling read and final pull before flushing the MP4", async () => {
    const first = rawFrames(960);
    const second = rawFrames(960);
    const third = rawFrames(960);
    const readStarted = deferred();
    const releaseRead = deferred();

    bridge.getRawAudioBuffers.mockImplementation(
      async (_recordingId: number, cursor: number) => {
        if (cursor === 0) {
          readStarted.resolve();
          await releaseRead.promise;
          return { buffer: first, nextCursor: first.byteLength };
        }
        if (cursor === first.byteLength) {
          return {
            buffer: second,
            nextCursor: first.byteLength + second.byteLength,
          };
        }
        if (cursor === first.byteLength + second.byteLength)
          return { buffer: third, nextCursor: cursor + third.byteLength };
        return { buffer: new Uint8Array(), nextCursor: cursor };
      },
    );

    const { createStreamEncoder } = await import("./opus-encoding");
    const stream = createStreamEncoder(41, {
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    const polling = stream.poll();
    await readStarted.promise;
    const finishing = stream.finish();
    releaseRead.resolve();

    const output = await finishing;
    await polling;
    const metadata = readAudioTrackMetadata(output);

    expect(bridge.getRawAudioBuffers.mock.calls).toEqual([
      [41, 0],
      [41, first.byteLength],
      [41, first.byteLength + second.byteLength],
      [41, first.byteLength + second.byteLength + third.byteLength],
    ]);
    expect(TestAudioData.instances.map((frame) => frame.timestamp)).toEqual([
      0, 20_000, 40_000,
    ]);
    expect(TestAudioData.instances.every((frame) => frame.closed)).toBe(true);
    expect(TestAudioEncoder.instances[0]?.flushCount).toBe(1);
    expect(metadata.codec).toBe("Opus");
    expect(metadata.sampleDeltas).toEqual([{ count: 3, delta: 960 }]);
    expect(metadata.duration / metadata.timescale).toBeCloseTo(0.06, 5);
  });

  test("an abort drops an in-flight read and cannot produce a final file", async () => {
    const readStarted = deferred();
    const releaseRead = deferred();
    bridge.getRawAudioBuffers.mockImplementation(async () => {
      readStarted.resolve();
      await releaseRead.promise;
      const buffer = rawFrames(960);
      return { buffer, nextCursor: buffer.byteLength };
    });

    const { createStreamEncoder } = await import("./opus-encoding");
    const stream = createStreamEncoder(42, {
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
    const polling = stream.poll();
    await readStarted.promise;
    const closing = stream.close();
    releaseRead.resolve();

    await Promise.all([polling, closing]);
    expect(TestAudioData.instances).toHaveLength(0);
    await expect(stream.finish()).rejects.toThrow("closed");
  });

  test("surfaces asynchronous WebCodecs failure from finish", async () => {
    const buffer = rawFrames(960);
    bridge.getRawAudioBuffers
      .mockResolvedValueOnce({
        buffer,
        nextCursor: buffer.byteLength,
      })
      .mockResolvedValueOnce({
        buffer: new Uint8Array(),
        nextCursor: buffer.byteLength,
      });
    TestAudioEncoder.failOnFlush = true;

    const { createStreamEncoder } = await import("./opus-encoding");
    const stream = createStreamEncoder(43, {
      sampleRate: 48_000,
      numberOfChannels: 2,
    });

    await expect(stream.finish()).rejects.toThrow(
      "Encoding error: synthetic encoder failure",
    );
  });
});
