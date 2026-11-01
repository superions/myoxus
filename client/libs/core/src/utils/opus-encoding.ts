import { DebugLogger } from "@myoxus/debug";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";

import { isLink } from "../modules/navigation/utils";
import { toArrayBuffer } from "./array-buffer";

interface AudioEncodingConfig {
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
}

interface AudioEncodingResult {
  encodedChunks: EncodedAudioChunk[];
  config: AudioEncodingConfig;
}

const logger = new DebugLogger("opus-encoding");
const apis = getDesktopBridge()?.apis;
const LOCAL_FILE_ASSET_URL = "assets://local-file";

// Constants
const DEFAULT_BITRATE = 64000;
const MAX_SLICE_DURATION_SECONDS = 10 * 60; // 10 minutes
const MIN_SLICE_DURATION_SECONDS = 5 * 60; // 5 minutes
const AUDIO_LEVEL_THRESHOLD = 0.02; // Threshold for "silence" detection

function assertAudioConfig(config: AudioEncodingConfig) {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate <= 0) {
    throw new Error("Audio sample rate must be greater than zero");
  }
  if (
    !Number.isInteger(config.numberOfChannels) ||
    config.numberOfChannels <= 0
  ) {
    throw new Error("Audio channel count must be a positive integer");
  }
}

function assertInterleavedFloat32Audio(
  byteLength: number,
  numberOfChannels: number,
) {
  if (byteLength === 0) throw new Error("Audio input is empty");
  const frameSize = Float32Array.BYTES_PER_ELEMENT * numberOfChannels;
  if (byteLength % frameSize !== 0) {
    throw new Error("Audio input does not contain complete interleaved frames");
  }
}

function encoderFailure(error: unknown) {
  return new Error(
    `Encoding error: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * Converts various blob formats to ArrayBuffer
 */
async function blobToArrayBuffer(
  blob: Blob | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  if (blob instanceof Blob) {
    return await blob.arrayBuffer();
  } else if (blob instanceof Uint8Array) {
    return toArrayBuffer(blob);
  }
  return toArrayBuffer(blob);
}

function getRecordingFileUrl(filepath: string): URL {
  const base =
    typeof location !== "undefined" && location.protocol === "assets:"
      ? LOCAL_FILE_ASSET_URL
      : typeof location !== "undefined"
        ? location.origin
        : LOCAL_FILE_ASSET_URL;

  // If filepath already contains a protocol, use it directly
  const fileUrl = isLink(filepath)
    ? new URL(filepath)
    : new URL(filepath, base);

  if (fileUrl.protocol === "assets:") {
    // Force requests to go through the local-file host so the protocol handler
    // can validate paths correctly.
    fileUrl.hostname = "local-file";
  }

  return fileUrl;
}

async function readRecordingFileBuffer(filepath: string): Promise<ArrayBuffer> {
  if (apis?.recording?.readRecordingFile) {
    try {
      const buffer = await apis.recording.readRecordingFile(filepath);
      return toArrayBuffer(buffer);
    } catch (error) {
      logger.error("Failed to read recording file via IPC", error);
    }
  }

  const response = await fetch(getRecordingFileUrl(filepath));
  if (!response.ok) {
    throw new Error(
      `Failed to fetch recording file: ${response.status} ${response.statusText}`,
    );
  }

  return await response.arrayBuffer();
}

/**
 * Extracts a combined Float32Array from an AudioBuffer
 */
function extractAudioData(
  audioBuffer: AudioBuffer,
  startSample: number = 0,
  endSample?: number,
): Float32Array {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleCount =
    endSample !== undefined
      ? endSample - startSample
      : audioBuffer.length - startSample;

  const audioData = new Float32Array(sampleCount * numberOfChannels);

  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < sampleCount; i++) {
      audioData[i * numberOfChannels + channel] = channelData[startSample + i];
    }
  }

  return audioData;
}

/**
 * Creates and configures an Opus encoder with the given settings
 */
export function createOpusEncoder(config: AudioEncodingConfig): {
  encoder: AudioEncoder;
  encodedChunks: EncodedAudioChunk[];
  flush: () => Promise<void>;
} {
  assertAudioConfig(config);
  if (typeof AudioEncoder === "undefined") {
    throw new Error("AudioEncoder is not available in this environment");
  }

  const encodedChunks: EncodedAudioChunk[] = [];
  let asynchronousError: unknown;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      encodedChunks.push(chunk);
    },
    error: (err) => {
      // WebCodecs reports encoder failures out-of-band. Store the failure and
      // surface it from the next awaited flush instead of throwing in a
      // detached callback where the recording workflow cannot recover.
      asynchronousError = err;
    },
  });

  encoder.configure({
    codec: "opus",
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    bitrate: config.bitrate ?? DEFAULT_BITRATE,
  });

  return {
    encoder,
    encodedChunks,
    flush: async () => {
      try {
        await encoder.flush();
      } catch (error) {
        throw encoderFailure(asynchronousError ?? error);
      }
      if (asynchronousError) throw encoderFailure(asynchronousError);
    },
  };
}

/**
 * Encodes audio frames using the provided encoder
 */
async function encodeAudioFrames({
  audioData,
  numberOfChannels,
  sampleRate,
  encoder,
  flush,
}: {
  audioData: Float32Array;
  numberOfChannels: number;
  sampleRate: number;
  encoder: AudioEncoder;
  flush: () => Promise<void>;
}): Promise<void> {
  assertAudioConfig({ sampleRate, numberOfChannels });
  assertInterleavedFloat32Audio(audioData.byteLength, numberOfChannels);
  const CHUNK_SIZE = numberOfChannels * 1024;
  let offset = 0;

  try {
    for (let i = 0; i < audioData.length; i += CHUNK_SIZE) {
      const chunkSize = Math.min(CHUNK_SIZE, audioData.length - i);
      const chunk = audioData.subarray(i, i + chunkSize);

      const frame = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: chunk.length / numberOfChannels,
        numberOfChannels,
        timestamp: (offset * 1000000) / sampleRate,
        data: toArrayBuffer(chunk),
      });

      try {
        encoder.encode(frame);
      } finally {
        frame.close();
      }

      offset += chunk.length / numberOfChannels;
    }
  } finally {
    try {
      await flush();
    } finally {
      if (encoder.state !== "closed") encoder.close();
    }
  }
}

/**
 * Creates a mp4 container with the encoded audio chunks
 */
export async function muxToMp4(
  encodedChunks: EncodedAudioChunk[],
  config: AudioEncodingConfig,
): Promise<Uint8Array> {
  assertAudioConfig(config);
  if (encodedChunks.length === 0) {
    throw new Error("MP4 output requires at least one encoded audio packet");
  }

  // Loading the shared audio utilities must not load the muxer. Import only
  // when producing MP4 output; load failures reject this operation normally.
  const {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    Mp4OutputFormat,
    Output,
  } = await import("mediabunny");
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const source = new EncodedAudioPacketSource("opus");
  output.addAudioTrack(source);

  try {
    await output.start();
    let previousTimestamp = -1;
    for (const [index, chunk] of encodedChunks.entries()) {
      if (
        !Number.isFinite(chunk.timestamp) ||
        chunk.timestamp < 0 ||
        chunk.timestamp <= previousTimestamp
      ) {
        throw new Error("Encoded audio packet timestamps must be monotone");
      }
      const duration = chunk.duration;
      if (duration === null || !Number.isFinite(duration) || duration <= 0) {
        throw new Error("Encoded audio packets require a positive duration");
      }
      previousTimestamp = chunk.timestamp;

      const packetData = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packetData);
      const packet = new EncodedPacket(
        packetData,
        chunk.type,
        chunk.timestamp / 1_000_000,
        duration / 1_000_000,
      );
      await source.add(
        packet,
        index === 0
          ? {
              decoderConfig: {
                codec: "opus",
                numberOfChannels: config.numberOfChannels,
                sampleRate: config.sampleRate,
              },
            }
          : undefined,
      );
    }
    await output.finalize();
  } catch (error) {
    try {
      await output.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "MP4 muxing and cleanup both failed",
      );
    }
    throw error;
  }

  if (!target.buffer) throw new Error("MP4 output did not finalize a buffer");
  return new Uint8Array(target.buffer);
}

/**
 * Process and encode audio data to Opus chunks
 */
async function encodeAudioBufferToOpus(
  audioBuffer: AudioBuffer,
  targetBitrate: number = DEFAULT_BITRATE,
): Promise<AudioEncodingResult> {
  const config: AudioEncodingConfig = {
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: audioBuffer.numberOfChannels,
    bitrate: targetBitrate,
  };

  const { encoder, encodedChunks, flush } = createOpusEncoder(config);
  const audioData = extractAudioData(audioBuffer);

  await encodeAudioFrames({
    audioData,
    numberOfChannels: config.numberOfChannels,
    sampleRate: config.sampleRate,
    encoder,
    flush,
  });

  return { encodedChunks, config };
}

/**
 * Encodes raw audio data to Opus in MP4 container.
 */
export async function encodeRawBufferToOpus({
  filepath,
  sampleRate,
  numberOfChannels,
}: {
  filepath: string;
  sampleRate: number;
  numberOfChannels: number;
}): Promise<Uint8Array> {
  logger.debug("Encoding raw buffer to Opus");

  const rawBuffer = await readRecordingFileBuffer(filepath);
  assertAudioConfig({ sampleRate, numberOfChannels });
  assertInterleavedFloat32Audio(rawBuffer.byteLength, numberOfChannels);
  const audioData = new Float32Array(rawBuffer);
  const { encoder, encodedChunks, flush } = createOpusEncoder({
    sampleRate,
    numberOfChannels,
  });

  await encodeAudioFrames({
    audioData,
    numberOfChannels,
    sampleRate,
    encoder,
    flush,
  });

  const mp4 = await muxToMp4(encodedChunks, {
    sampleRate,
    numberOfChannels,
  });
  logger.debug("Encoded raw buffer to Opus");
  return mp4;
}

/**
 * Encodes an audio file Blob to Opus in MP4 container with specified bitrate.
 * @param blob Input audio file blob (supports any browser-decodable format)
 * @param targetBitrate Target bitrate in bits per second (bps)
 * @returns Promise resolving to encoded MP4 data as Uint8Array
 */
export async function encodeAudioBlobToOpus(
  blob: Blob | ArrayBuffer | Uint8Array,
  targetBitrate: number = DEFAULT_BITRATE,
): Promise<Uint8Array> {
  const audioContext = new AudioContext();
  logger.debug("Encoding audio blob to Opus");

  try {
    const arrayBuffer = await blobToArrayBuffer(blob);
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const { encodedChunks, config } = await encodeAudioBufferToOpus(
      audioBuffer,
      targetBitrate,
    );

    const mp4 = await muxToMp4(encodedChunks, config);
    logger.debug("Encoded audio blob to Opus");
    return mp4;
  } finally {
    await audioContext.close();
  }
}

/**
 * Finds the best slice point based on audio level
 */
function findSlicePoint(
  audioBuffer: AudioBuffer,
  startSample: number,
  endSample: number,
  minSliceSamples: number,
): number {
  // If we have more than min slice duration and not at the end,
  // look for a good splitting point (low audio level)
  if (
    endSample < audioBuffer.length &&
    endSample - startSample > minSliceSamples
  ) {
    // Start checking from min slice duration point
    const checkStartSample = startSample + minSliceSamples;
    const numberOfChannels = audioBuffer.numberOfChannels;

    // Scan forward for a good split point (low audio level)
    for (let i = checkStartSample; i < endSample; i++) {
      // Calculate average level across all channels at this sample
      let level = 0;
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const data = audioBuffer.getChannelData(channel);
        level += Math.abs(data[i]);
      }
      level /= numberOfChannels;

      // If we found a quiet spot, use it as the split point
      if (level < AUDIO_LEVEL_THRESHOLD) {
        return i;
      }
    }
  }

  // If no good splitting point is found, use the original end sample
  return endSample;
}

// Since the audio blob could be long and make the transcribe service busy,
// we need to encode the audio blob to opus slices
// Slice logic:
// 1. Max slice duration is 10 minutes
// 2. Min slice duration is 5 minutes
// 3. If a new slice begins and the duration reached 5 minutes
//    we start a new slice when the audio level value is below the threshold
// 4. If the audio level value is above the threshold, we continue the current slice
export async function encodeAudioBlobToOpusSlices(
  blob: Blob | ArrayBuffer | Uint8Array,
  targetBitrate: number = DEFAULT_BITRATE,
): Promise<Uint8Array[]> {
  const audioContext = new AudioContext();

  try {
    const arrayBuffer = await blobToArrayBuffer(blob);
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const slices: Uint8Array[] = [];

    // Define slicing parameters
    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = audioBuffer.numberOfChannels;

    // Calculate sizes in samples
    const maxSliceSamples = MAX_SLICE_DURATION_SECONDS * sampleRate;
    const minSliceSamples = MIN_SLICE_DURATION_SECONDS * sampleRate;
    const totalSamples = audioBuffer.length;

    // Start slicing
    let startSample = 0;

    while (startSample < totalSamples) {
      // Determine end sample for this slice
      let endSample = Math.min(startSample + maxSliceSamples, totalSamples);

      // Find the best slice point based on audio levels
      endSample = findSlicePoint(
        audioBuffer,
        startSample,
        endSample,
        minSliceSamples,
      );

      // Create a slice from startSample to endSample
      const audioData = extractAudioData(audioBuffer, startSample, endSample);

      // Encode this slice to Opus
      const { encoder, encodedChunks, flush } = createOpusEncoder({
        sampleRate,
        numberOfChannels,
        bitrate: targetBitrate,
      });

      await encodeAudioFrames({
        audioData,
        numberOfChannels,
        sampleRate,
        encoder,
        flush,
      });

      // Mux to MP4 and add to slices
      const mp4 = await muxToMp4(encodedChunks, {
        sampleRate,
        numberOfChannels,
        bitrate: targetBitrate,
      });

      slices.push(mp4);

      // Move to next slice
      startSample = endSample;
    }

    logger.debug(`Encoded audio blob to ${slices.length} Opus slices`);
    return slices;
  } finally {
    await audioContext.close();
  }
}

export const createStreamEncoder = (
  recordingId: number,
  codecs: {
    sampleRate: number;
    numberOfChannels: number;
    targetBitrate?: number;
  },
) => {
  const {
    encoder,
    encodedChunks,
    flush: flushEncoder,
  } = createOpusEncoder({
    sampleRate: codecs.sampleRate,
    numberOfChannels: codecs.numberOfChannels,
    bitrate: codecs.targetBitrate,
  });
  let cursor = 0;
  let encodedFrameCount = 0;
  let state: "active" | "finishing" | "closed" = "active";
  let operationQueue = Promise.resolve();
  let terminalError: unknown;
  let finishPromise: Promise<Uint8Array> | undefined;
  let closePromise: Promise<void> | undefined;
  let pollPromise: Promise<void> | undefined;
  let wakePoll: (() => void) | undefined;

  const stopPolling = () => {
    wakePoll?.();
    wakePoll = undefined;
  };

  const waitForNextPoll = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakePoll = undefined;
        resolve();
      }, 1000);
      wakePoll = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(async () => {
      if (terminalError) throw terminalError;
      try {
        return await operation();
      } catch (error) {
        terminalError = error;
        state = "closed";
        stopPolling();
        if (encoder.state !== "closed") encoder.close();
        throw error;
      }
    });
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const pullNext = async () => {
    if (!apis) {
      throw new Error("Electron API is not available");
    }
    const { buffer, nextCursor } = await apis.recording.getRawAudioBuffers(
      recordingId,
      cursor,
    );
    if (state === "closed") return;
    if (!Number.isInteger(nextCursor) || nextCursor < cursor) {
      throw new Error("Recording cursor must advance monotonically");
    }
    if (nextCursor === cursor) {
      if (buffer.byteLength !== 0) {
        throw new Error("Recording cursor did not cover the returned audio");
      }
      return;
    }
    if (buffer.byteLength !== nextCursor - cursor) {
      throw new Error("Recording cursor and audio buffer length disagree");
    }

    assertInterleavedFloat32Audio(buffer.byteLength, codecs.numberOfChannels);
    const numberOfFrames =
      buffer.byteLength /
      Float32Array.BYTES_PER_ELEMENT /
      codecs.numberOfChannels;
    const frame = new AudioData({
      format: "f32",
      sampleRate: codecs.sampleRate,
      numberOfChannels: codecs.numberOfChannels,
      numberOfFrames,
      timestamp: (encodedFrameCount * 1_000_000) / codecs.sampleRate,
      data: toArrayBuffer(buffer),
    });
    try {
      encoder.encode(frame);
    } finally {
      frame.close();
    }
    logger.debug("Encoded recording bytes", {
      fromCursor: cursor,
      toCursor: nextCursor,
    });
    cursor = nextCursor;
    encodedFrameCount += numberOfFrames;
  };

  const next = () => {
    if (state !== "active") return Promise.resolve();
    return serialize(async () => {
      if (state === "active") await pullNext();
    });
  };

  const poll = () => {
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      while (state === "active") {
        await next();
        if (state === "active") await waitForNextPoll();
      }
    })();
    return pollPromise;
  };

  const close = () => {
    if (closePromise) return closePromise;
    state = "closed";
    stopPolling();
    closePromise = operationQueue.then(() => {
      if (encoder.state !== "closed") encoder.close();
    });
    return closePromise;
  };

  return {
    id: recordingId,
    next,
    poll,
    flush: () => serialize(flushEncoder),
    close,
    finish: () => {
      if (finishPromise) return finishPromise;
      if (state === "closed") {
        return Promise.reject(
          terminalError ?? new Error("Recording encoder was closed"),
        );
      }
      logger.debug("Finishing encoding");
      state = "finishing";
      stopPolling();
      finishPromise = serialize(async () => {
        // Capture bytes written while the poller slept before flushing the
        // encoder. Muxing an unflushed packet list can silently lose the tail.
        // Main returns bounded chunks. Drain the complete flushed file, not
        // merely the first chunk after the poller stops.
        let previousCursor: number;
        do {
          previousCursor = cursor;
          await pullNext();
        } while (cursor !== previousCursor);
        await flushEncoder();
        const buffer = await muxToMp4(encodedChunks, {
          sampleRate: codecs.sampleRate,
          numberOfChannels: codecs.numberOfChannels,
          bitrate: codecs.targetBitrate,
        });
        if (encoder.state !== "closed") encoder.close();
        state = "closed";
        return buffer;
      });
      return finishPromise;
    },
    [Symbol.dispose]: () => {
      void close();
    },
  };
};

export type OpusStreamEncoder = ReturnType<typeof createStreamEncoder>;
