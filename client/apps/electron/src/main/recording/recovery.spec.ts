// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { RecordingRecoveryStore } from "./recovery";

describe("native audio recovery", () => {
  test("restart retains the original, destination and delivery IDs; explicit deletion alone removes files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "myoxus-recording-"));
    try {
      const report = vi.fn();
      const store = new RecordingRecoveryStore(directory, report);
      writeFileSync(
        path.join(directory, "source.raw"),
        new Uint8Array([1, 2, 3, 4]),
      );
      store.put({
        id: 0,
        status: "recording",
        startTime: 100,
        rawFilename: "source.raw",
        sampleRate: 48000,
        numberOfChannels: 2,
        destination: {
          workspaceId: "original",
          serverId: null,
          savingMode: "journal-today",
        },
      });
      const recovered = new RecordingRecoveryStore(directory, report);
      expect(recovered.status(0)).toMatchObject({
        id: 0,
        status: "create-block-failed",
        destination: { workspaceId: "original", savingMode: "journal-today" },
      });
      expect(readFileSync(path.join(directory, "source.raw"))).toEqual(
        Buffer.from([1, 2, 3, 4]),
      );
      recovered.put({
        ...recovered.records.get(0)!,
        status: "ready",
        encodedFilename: "source.mp4",
        delivery: { docId: "journal", attachmentId: "audio", blobId: "blob" },
      });
      expect(
        new RecordingRecoveryStore(directory, report).status(0)?.delivery,
      ).toEqual({ docId: "journal", attachmentId: "audio", blobId: "blob" });
      expect(existsSync(path.join(directory, "source.raw"))).toBe(true);
      recovered.delete(0);
      expect(existsSync(path.join(directory, "source.raw"))).toBe(false);
      expect(
        new RecordingRecoveryStore(directory, report).status(0),
      ).toBeNull();
      expect(report).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("invalid recovery paths cannot expose or delete files outside the recording directory", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "myoxus-recording-"));
    try {
      const report = vi.fn();
      writeFileSync(
        path.join(directory, "0.json"),
        JSON.stringify({
          id: 0,
          status: "stopped",
          startTime: 100,
          rawFilename: "../outside.raw",
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      );
      const store = new RecordingRecoveryStore(directory, report);
      expect(store.status(0)).toBeNull();
      expect(report).toHaveBeenCalledOnce();
      expect(() =>
        store.put({
          id: 0,
          status: "stopped",
          startTime: 100,
          rawFilename: "../outside.raw",
          sampleRate: 48000,
          numberOfChannels: 2,
        }),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
