// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BlobReader,
  ZipReader,
  ZipWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
} from "@zip.js/zip.js";

/** Explicit fixture inventory: do not synthesize directories or normalize the
 * deliberately unsafe names used by negative import cases. */
export async function createZipFixture(
  entries: Iterable<readonly [string, string | Uint8Array | Blob]>,
) {
  const archive = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const [name, content] of entries) {
    const reader =
      typeof content === "string"
        ? new TextReader(content)
        : content instanceof Uint8Array
          ? new Uint8ArrayReader(content)
          : new BlobReader(content);
    await archive.add(name, name.endsWith("/") ? undefined : reader, {
      directory: name.endsWith("/"),
      level: 0,
    });
  }
  return new Uint8Array(await archive.close());
}

export async function readZipFixture(bytes: Uint8Array | Blob) {
  const archive = new ZipReader(
    bytes instanceof Uint8Array
      ? new Uint8ArrayReader(bytes)
      : new BlobReader(bytes),
    {
      checkSignature: true,
      useWebWorkers: false,
    },
  );
  try {
    const files = new Map<string, Uint8Array<ArrayBuffer>>();
    for await (const entry of archive.getEntriesGenerator()) {
      files.set(
        entry.filename,
        entry.directory
          ? new Uint8Array()
          : new Uint8Array(
              await entry.getData(new Uint8ArrayWriter(), {
                checkSignature: true,
              }),
            ),
      );
    }
    return files;
  } finally {
    await archive.close();
  }
}
