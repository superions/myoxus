// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readNativeTemplateBundle } from "../services/native-bundle";

const bundle = () =>
  new Uint8Array(
    readFileSync(
      resolve(
        process.cwd(),
        "server/templates/documents/meeting-focus/1.1.1.zip",
      ),
    ),
  );
beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("committed native Fokus bundle", () => {
  test("rejects a non-selected language mutation before returning any content", async () => {
    const archive = await JSZip.loadAsync(bundle());
    archive.file("localized/es.template.zip", "changed bytes");
    await expect(
      readNativeTemplateBundle(
        await archive.generateAsync({ type: "uint8array" }),
        "de",
      ),
    ).rejects.toThrow("checksum mismatch");
  });

  test("rejects an undeclared locale in a single-language bundle", async () => {
    const bytes = new Uint8Array(
      readFileSync(
        resolve(
          process.cwd(),
          "server/templates/documents/meeting-focus/1.0.1.zip",
        ),
      ),
    );
    const archive = await JSZip.loadAsync(bytes);
    archive.file("localized/fr.template.zip", "hidden payload");
    await expect(
      readNativeTemplateBundle(
        await archive.generateAsync({ type: "uint8array" }),
        "de",
      ),
    ).rejects.toThrow("Undeclared native locale payload");
  });

  test("retains the existing single-language native bundle", async () => {
    const bytes = new Uint8Array(
      readFileSync(
        resolve(
          process.cwd(),
          "server/templates/documents/meeting-focus/1.0.1.zip",
        ),
      ),
    );
    const result = await readNativeTemplateBundle(bytes, "fr");
    expect(result.locale).toBe("de");
    expect(result.title).toBe("Fokus · Besprechungsprotokoll");
  });
});
