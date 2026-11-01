// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type RecordingDestination,
  type RecordingStatus,
} from "@myoxus/desktop-api-contract";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const destinationSchema: z.ZodType<RecordingDestination> = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string().max(4096).optional(),
  serverId: z.string().nullable(),
  serverBaseUrl: z.string().optional(),
  savingMode: z.enum(["new-doc", "journal-today"]),
});
const filename = z.string().regex(/^[\w.-]+\.(raw|mp4)$/);
const recordSchema = z.object({
  id: z.number().int().nonnegative().safe(),
  status: z.enum([
    "new",
    "recording",
    "paused",
    "stopped",
    "ready",
    "create-block-success",
    "create-block-failed",
  ]),
  startTime: z.number().nonnegative(),
  appName: z.string().optional(),
  rawFilename: filename.refine((value) => value.endsWith(".raw")),
  encodedFilename: filename
    .refine((value) => value.endsWith(".mp4"))
    .optional(),
  sampleRate: z.number().positive(),
  numberOfChannels: z.number().int().positive(),
  destination: destinationSchema.optional(),
  delivery: z
    .object({
      docId: z.string().min(1),
      attachmentId: z.string().min(1),
      blobId: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});
export type RecordingRecovery = z.infer<typeof recordSchema>;

/** Audio and its destination survive renderer failure and application restart.
 * Each small manifest is replaced atomically; only explicit deletion removes it. */
export class RecordingRecoveryStore {
  readonly records = new Map<number, RecordingRecovery>();
  constructor(
    readonly directory: string,
    private readonly reportError: (error: unknown) => void,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const filename of readdirSync(directory).filter((name) =>
      /^\d+\.json$/.test(name),
    )) {
      try {
        const file = path.join(directory, filename);
        if (statSync(file).size > 64 * 1024)
          throw new Error("Recording recovery metadata is too large");
        const record = recordSchema.parse(
          JSON.parse(readFileSync(file, "utf8")),
        );
        if (filename !== `${record.id}.json`)
          throw new Error("Recording recovery identity does not match");
        if (record.status === "recording" || record.status === "paused") {
          record.status = "create-block-failed";
          record.error =
            "Recording was interrupted. The original audio is retained; retry saving it.";
        }
        this.records.set(record.id, record);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  put(value: RecordingRecovery) {
    const record = recordSchema.parse(value);
    const filepath = path.join(this.directory, `${record.id}.json`);
    const temporary = `${filepath}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, filepath);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.records.set(record.id, record);
  }

  status(id: number): RecordingStatus | null {
    const record = this.records.get(id);
    if (!record) return null;
    return {
      ...record,
      filepath: path.join(
        this.directory,
        record.encodedFilename ?? record.rawFilename,
      ),
    };
  }

  /** The caller rejects active capture before invoking this explicit action. */
  delete(id: number) {
    const record = this.records.get(id);
    if (!record) return;
    for (const filename of [
      record.rawFilename,
      record.encodedFilename,
      `${id}.json`,
    ]) {
      if (filename)
        rmSync(path.join(this.directory, filename), { force: true });
    }
    this.records.delete(id);
  }
}
