// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { ZipReader, Uint8ArrayReader } from "@zip.js/zip.js";

/** Build-only bounded archive decoding. Runtime clients receive the validated
 * payloads, never an archive or an executable bundle-provided path. */
export async function readNativeArchive(bytes) {
  assert(bytes.length <= 50 * 1024 * 1024, "Native archive exceeds size limit");
  const zip = new ZipReader(new Uint8ArrayReader(bytes), {
    checkSignature: true,
    useWebWorkers: false,
  });
  const files = new Map();
  let total = 0;
  try {
    let count = 0;
    for await (const entry of zip.getEntriesGenerator()) {
      assert(++count <= 256, "Native archive exceeds entry limit");
      const name = entry.filename.replace(/\/$/, "");
      assert(
        name &&
          !name.includes("\\") &&
          !/^[A-Za-z]:/.test(name) &&
          !name
            .split("/")
            .some((part) => !part || part === "." || part === ".."),
        "Unsafe native archive path",
      );
      assert(!files.has(entry.filename), "Duplicate native archive path");
      if (entry.directory) continue;
      let size = 0;
      const chunks = [];
      await entry.getData(
        new WritableStream({
          write(chunk) {
            size += chunk.length;
            total += chunk.length;
            assert(
              size <= 50 * 1024 * 1024 && total <= 200 * 1024 * 1024,
              "Native archive output exceeds limits",
            );
            chunks.push(chunk.slice());
          },
        }),
        { checkSignature: true },
      );
      files.set(entry.filename, Buffer.concat(chunks));
    }
    return files;
  } finally {
    await zip.close();
  }
}

export async function readNativeBundle(bytes, checksum) {
  const files = await readNativeArchive(bytes);
  assert(
    files.has("manifest.json") && files.has("content.template.zip"),
    "Incomplete document bundle",
  );
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const content = files.get("content.template.zip");
  assert(manifest.title, "Missing native bundle title");
  assert(
    !manifest.purpose || ["template", "guide"].includes(manifest.purpose),
    "Invalid native bundle purpose",
  );
  assert(
    !manifest.title_policy ||
      ["template", "template-date", "date"].includes(manifest.title_policy),
    "Invalid native title policy",
  );
  if (manifest.checksum)
    assert.equal(
      checksum(content),
      manifest.checksum,
      "Native default payload checksum mismatch",
    );
  const variants = new Map();
  const paths = new Set();
  const normalize = (locale) =>
    locale.trim().replaceAll("_", "-").toLowerCase();
  for (const [locale, variant] of Object.entries(
    manifest.localized_contents ?? {},
  )) {
    assert(
      locale &&
        variant?.title &&
        files.has(variant.path) &&
        !paths.has(variant.path) &&
        !variants.has(normalize(locale)),
      "Invalid native locale payload",
    );
    const payload = files.get(variant.path);
    assert.equal(
      checksum(payload),
      variant.sha256,
      "Native locale payload checksum mismatch",
    );
    if (manifest.locale && normalize(locale) === normalize(manifest.locale))
      assert.equal(
        checksum(payload),
        checksum(content),
        "Conflicting native default locale payload",
      );
    variants.set(normalize(locale), { ...variant, content: payload });
    paths.add(variant.path);
  }
  for (const name of files.keys()) {
    assert(
      ["manifest.json", "content.template.zip", "preview.svg"].includes(name) ||
        paths.has(name) ||
        name.startsWith("__MACOSX/") ||
        name
          .split("/")
          .some((part) => part === ".DS_Store" || part.startsWith("._")),
      "Undeclared native locale payload",
    );
  }
  return { manifest, content, variants };
}
