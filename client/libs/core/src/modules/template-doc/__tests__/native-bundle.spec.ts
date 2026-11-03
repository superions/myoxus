// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createZipFixture,
  readZipFixture,
} from "../../../__tests__/zip-fixture";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readNativeTemplateBundle } from "../services/native-bundle";
import { nativeDocumentBundles } from "../services/source-metadata";

const bundle = nativeDocumentBundles.find(
  (bundle) => bundle.template_id === "welcome-myoxus",
)!;
const load = async (asset: string) =>
  new Uint8Array(
    readFileSync(
      resolve(process.cwd(), "client/libs/core/public/document-bundles", asset),
    ),
  );
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

// Source archive admission moved to the build owner, not to another runtime
// parser. Keep the previous negative inputs against that actual decoder.
const sourceDecoder = pathToFileURL(
  resolve(process.cwd(), "build/scripts/templates/native-payload.mjs"),
).href;
const checksum = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
test("build admission rejects a non-selected language mutation", async () => {
  const { readNativeBundle } = await import(/* @vite-ignore */ sourceDecoder);
  const archive = await readZipFixture(
    readFileSync(
      resolve(
        process.cwd(),
        "server/templates/documents/meeting-focus/1.1.1.zip",
      ),
    ),
  );
  archive.set(
    "localized/es.template.zip",
    new TextEncoder().encode("changed bytes"),
  );
  await expect(
    readNativeBundle(await createZipFixture(archive), checksum),
  ).rejects.toThrow("checksum mismatch");
});
test("build admission rejects an undeclared locale and retains single-language sources", async () => {
  const { readNativeBundle } = await import(/* @vite-ignore */ sourceDecoder);
  const bytes = readFileSync(
    resolve(
      process.cwd(),
      "server/templates/documents/meeting-focus/1.0.1.zip",
    ),
  );
  const decoded = await readNativeBundle(bytes, checksum);
  expect(decoded.manifest.locale).toBe("de");
  expect(decoded.manifest.title).toBe("Fokus · Besprechungsprotokoll");
  const archive = await readZipFixture(bytes);
  archive.set(
    "localized/fr.template.zip",
    new TextEncoder().encode("hidden payload"),
  );
  await expect(
    readNativeBundle(await createZipFixture(archive), checksum),
  ).rejects.toThrow("Undeclared native locale payload");
});

describe("prepared native bundle delivery", () => {
  test("rejects changed payload or image bytes before returning content", async () => {
    const locale = bundle.contents.de;
    for (const target of [locale.asset, locale.assets![0].asset]) {
      await expect(
        readNativeTemplateBundle(bundle, "de", (asset) =>
          asset === target
            ? Promise.resolve(new Uint8Array([1, 2, 3]))
            : load(asset),
        ),
      ).rejects.toThrow("checksum mismatch");
    }
  });
  test("selects regional language once and falls back to its declared default", async () => {
    const regional = await readNativeTemplateBundle(bundle, "fr-CA", load);
    expect(regional.locale).toBe("fr");
    const fallback = await readNativeTemplateBundle(bundle, "ja", load);
    expect(fallback.locale).toBe(bundle.defaultLocale);
    expect(fallback.title).toBe(bundle.contents[bundle.defaultLocale].title);
    expect(fallback.content.kind).toBe("snapshot");
  });
});
