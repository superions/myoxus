import { extMimeMap, getAssetName } from "@virgultum/store";
import {
  BlobReader,
  BlobWriter,
  TextReader,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { parseDocument, Scalar, visit } from "yaml";

export class Zip {
  private readonly zip: ZipWriter<Blob>;
  private result?: Promise<Blob>;

  constructor(signal?: AbortSignal) {
    this.zip = new ZipWriter(new BlobWriter("application/zip"), {
      useWebWorkers: false,
      keepOrder: true,
      signal,
    });
  }

  async file(path: string, content: Blob | File | string) {
    if (this.result) throw new Error("Archive is already finalized");
    validateArchivePath(path);
    await this.zip.add(
      path,
      typeof content === "string"
        ? new TextReader(content)
        : new BlobReader(content),
    );
  }

  folder(folderPath: string) {
    return {
      folder: (folderPath2: string) => {
        return this.folder(`${folderPath}/${folderPath2}`);
      },
      file: async (name: string, blob: Blob) => {
        await this.file(`${folderPath}/${name}`, blob);
      },
      generate: async () => {
        return this.generate();
      },
    };
  }

  async generate() {
    return (this.result ??= this.zip.close());
  }
}

function validateArchivePath(path: string) {
  const name = path.replace(/\/$/, "");
  if (
    !name ||
    /[\\\p{Cc}]/u.test(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Unsafe ZIP entry path");
  }
}

// Bound decompressed data at the untrusted archive boundary, before retaining
// chunks or creating documents. Central-directory sizes are only an early check.
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 2048;

/** One-shot archive stream, closed even on failed or interrupted iteration.
 * Consumers must collect and validate all entries before publishing documents:
 * a later CRC/path error must not leave partially imported pages. */
export class Unzip {
  private archive?: ZipReader<Blob>;
  private signal?: AbortSignal;

  async load(blob: Blob, signal?: AbortSignal) {
    await this.archive?.close();
    this.archive = undefined;
    signal?.throwIfAborted();
    if (blob.size > MAX_ARCHIVE_BYTES)
      throw new Error("ZIP archive exceeds input limit");
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    signal?.throwIfAborted();
    if (
      signature[0] !== 0x50 ||
      signature[1] !== 0x4b ||
      !(
        (signature[2] === 3 && signature[3] === 4) ||
        (signature[2] === 5 && signature[3] === 6)
      )
    ) {
      throw new Error("Invalid ZIP archive signature");
    }
    this.signal = signal;
    this.archive = new ZipReader(new BlobReader(blob), {
      checkSignature: true,
      useWebWorkers: false,
      // macOS archives can contain valid UTF-8 without the language bit. Keep
      // the library's legacy decoding only when those raw bytes are not UTF-8.
      decodeText(bytes) {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return undefined;
        }
      },
    });
  }

  async *[Symbol.asyncIterator]() {
    const archive = this.archive;
    if (!archive) throw new Error("ZIP archive is not loaded");
    this.archive = undefined;
    const signal = this.signal;
    const names = new Set<string>();
    let total = 0;
    let entries = 0;
    let index = 0;
    try {
      for await (const entry of archive.getEntriesGenerator()) {
        signal?.throwIfAborted();
        if (++entries > MAX_ENTRIES)
          throw new Error("ZIP archive exceeds entry limit");
        const path = entry.filename;
        validateArchivePath(path);
        if (names.has(path)) throw new Error("Duplicate ZIP entry path");
        names.add(path);
        if (entry.directory) continue;
        if (
          entry.uncompressedSize > MAX_ENTRY_BYTES ||
          total + entry.uncompressedSize > MAX_TOTAL_BYTES
        )
          throw new Error("ZIP archive exceeds output limits");
        let size = 0;
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        await entry.getData(
          new WritableStream<Uint8Array>({
            write(chunk) {
              size += chunk.byteLength;
              total += chunk.byteLength;
              if (size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES)
                throw new Error("ZIP archive exceeds output limits");
              chunks.push(new Uint8Array(chunk));
            },
          }),
          { checkSignature: true, signal },
        );
        if (path.includes("__MACOSX") || path.includes("DS_Store")) continue;
        const name = path.substring(path.lastIndexOf("/") + 1);
        const extension = name.includes(".")
          ? name.split(".").at(-1)?.toLowerCase()
          : "";
        const content = new File(chunks, name, {
          type: extMimeMap.get(extension ?? "") ?? "",
        });
        yield { path, content: content as Blob, index: index++ };
      }
    } finally {
      await archive.close();
    }
  }
}

export async function createAssetsArchive(
  assetsMap: Map<string, Blob>,
  assetsIds: string[],
) {
  const zip = new Zip();

  for (const [id, blob] of assetsMap) {
    if (!assetsIds.includes(id)) continue;
    const name = getAssetName(assetsMap, id);
    await zip.folder("assets").file(name, blob);
  }

  return zip;
}

export function download(blob: Blob, name: string) {
  const element = document.createElement("a");
  element.setAttribute("download", name);
  const fileURL = URL.createObjectURL(blob);
  element.setAttribute("href", fileURL);
  element.style.display = "none";
  document.body.append(element);
  element.click();
  element.remove();
  URL.revokeObjectURL(fileURL);
}

const metaMatcher = /^---[ \t]*(\r?\n(?:[\s\S]*?\r?\n)?)---[ \t]*(?=\r?\n|$)/;
export const parseMatter = (contents: string) => {
  const matterMatch = contents.match(metaMatcher);
  if (!matterMatch) return null;
  const document = parseDocument(matterMatch[1], {
    schema: "core",
  });
  // Unknown tags otherwise produce a warning and silently fall back to text.
  const error =
    document.errors[0] ??
    document.warnings.find((warning) => warning.code === "TAG_RESOLVE_FAILED");
  if (error) throw error;
  // Preserve literal titles/tags such as 0123 and yes; explicit standard YAML
  // types still reach the importer's metadata normalizers as typed values.
  visit(document, {
    Scalar(_key, node) {
      if (node.type === Scalar.PLAIN && !node.tag) node.value = node.source;
    },
  });
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const body = contents.slice(matterMatch[0].length);
  return { matter: matterMatch[1], body, metadata };
};
