// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ZipReader,
  ZipWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  TextReader,
} from "@zip.js/zip.js";

/** In-memory tooling archives, including deliberately unsafe negative fixtures.
 * Names remain data: this helper never extracts paths onto a filesystem. */
export async function readZip(
  bytes,
  {
    maxEntries = 10_000,
    maxEntryBytes = 64 * 1024 * 1024,
    maxBytes = 256 * 1024 * 1024,
  } = {},
) {
  const archive = new ZipReader(new Uint8ArrayReader(bytes), {
    checkSignature: true,
    useWebWorkers: false,
  });
  const result = new Map();
  let total = 0;
  let count = 0;
  try {
    for await (const entry of archive.getEntriesGenerator()) {
      if (++count > maxEntries || result.has(entry.filename))
        throw new Error("Invalid tooling ZIP inventory");
      let size = 0;
      const chunks = [];
      if (!entry.directory)
        await entry.getData(
          new WritableStream({
            write(chunk) {
              size += chunk.byteLength;
              total += chunk.byteLength;
              if (size > maxEntryBytes || total > maxBytes)
                throw new Error("Tooling ZIP exceeds output limits");
              chunks.push(chunk.slice());
            },
          }),
          { checkSignature: true },
        );
      result.set(entry.filename, {
        data: Buffer.concat(chunks),
        directory: entry.directory,
      });
    }
    return result;
  } finally {
    await archive.close();
  }
}

/** Write exactly the supplied inventory; no inferred parent-directory entries. */
export async function writeZip(
  entries,
  { date = new Date("2026-01-01T00:00:00.000Z"), level = 6 } = {},
) {
  const archive = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    keepOrder: true,
  });
  for (const [name, value] of entries) {
    const entry =
      value && typeof value === "object" && "data" in value
        ? value
        : { data: value };
    const data = entry.data;
    await archive.add(
      name,
      entry.directory
        ? undefined
        : typeof data === "string"
          ? new TextReader(data)
          : new Uint8ArrayReader(data),
      {
        directory: Boolean(entry.directory),
        lastModDate: date,
        level,
        extendedTimestamp: false,
      },
    );
  }
  return Buffer.from(await archive.close());
}
