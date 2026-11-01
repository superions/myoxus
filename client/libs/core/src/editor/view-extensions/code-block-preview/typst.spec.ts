// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { TYPST_FONT_URLS } from "./typst-fonts";
import { getTypst } from "./typst";
import { TypstCompileWorld } from "@myriaddreamin/typst-ts-web-compiler";
import { RenderSession, TypstRenderer } from "@myriaddreamin/typst-ts-renderer";

vi.mock("@myriaddreamin/typst-ts-web-compiler", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@myriaddreamin/typst-ts-web-compiler")
    >();
  return {
    ...actual,
    default: () =>
      actual.default({
        module_or_path: readFileSync(
          "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
        ),
      }),
  };
});
vi.mock("@myriaddreamin/typst-ts-renderer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@myriaddreamin/typst-ts-renderer")>();
  return {
    ...actual,
    default: () =>
      actual.default({
        module_or_path: readFileSync(
          "node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm",
        ),
      }),
  };
});

const directory = mkdtempSync(join(tmpdir(), "myoxus-typst-"));
let packageBytes: Buffer;
let packageRequests = 0;
const fontFetch = vi.fn(
  async (url: string) =>
    new Response(
      readFileSync(`server/static/fonts/${url.slice("/api/fonts/".length)}`),
    ),
);

beforeAll(() => {
  writeFileSync(
    join(directory, "typst.toml"),
    '[package]\nname = "myoxus-preview-test"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
  );
  writeFileSync(
    join(directory, "lib.typ"),
    "#let greeting = [Package import works]\n",
  );
  packageBytes = execFileSync("tar", [
    "--format=ustar",
    "-czf",
    "-",
    "-C",
    directory,
    "typst.toml",
    "lib.typ",
  ]);
  vi.stubGlobal("fetch", fontFetch);
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      status = 200;
      response = "";
      overrideMimeType() {}
      open(method: string, url: string, async: boolean) {
        expect(method).toBe("GET");
        expect(url).toBe(
          "https://packages.typst.org/preview/myoxus-preview-test-0.1.0.tar.gz",
        );
        expect(async).toBe(false);
      }
      send() {
        packageRequests++;
        this.response = packageBytes.toString("latin1");
      }
    },
  );
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

test("initialization retries a missing font and shares one owned font load", async () => {
  fontFetch.mockRejectedValueOnce(new Error("font network failure"));
  await expect(getTypst()).rejects.toThrow("font network failure");
  const [first, second] = await Promise.all([getTypst(), getTypst()]);
  expect(first).toBe(second);
  expect(fontFetch.mock.calls.map(([url]) => url)).toEqual([
    ...TYPST_FONT_URLS,
    ...TYPST_FONT_URLS,
  ]);
});

test("real WASM renders default serif, math and a server-owned font", async () => {
  const preview = await getTypst();
  const svg = await preview.svg({
    mainContent:
      "#set page(width: 240pt, height: auto)\nHello, Myoxus! $ x^2 + y^2 = z^2 $",
  });
  expect(svg).toContain('viewBox="0 0 240.000 89.000"');
  expect(svg).toContain("Hello, Myoxus!");
  expect(svg).toContain("𝑥");
  const inter = await preview.svg({
    mainContent: '#set text(font: "Inter")\nServer font',
  });
  expect(inter).toContain("Server font");
});

test("native package imports and their files remain cached across renders", async () => {
  const preview = await getTypst();
  const code =
    '#import "@preview/myoxus-preview-test:0.1.0": greeting\n#greeting';
  for (let i = 0; i < 2; i++)
    expect(await preview.svg({ mainContent: code })).toContain(
      "Package import works",
    );
  expect(packageRequests).toBe(1);
});

test("compiler diagnostics retain locations and a failure does not contaminate the next document", async () => {
  const preview = await getTypst();
  await expect(preview.svg({ mainContent: "#let x = (" })).rejects.toThrow(
    "myoxus-preview.typ:1:10: error: unclosed delimiter",
  );
  const svg = await preview.svg({ mainContent: "Next document" });
  expect(svg).toContain("Next document");
  expect(svg).not.toContain("Package import works");
});

test("render failures release the native session and compile world", async () => {
  const preview = await getTypst();
  const freeWorld = vi.spyOn(TypstCompileWorld.prototype, "free");
  const freeSession = vi.spyOn(RenderSession.prototype, "free");
  const render = vi
    .spyOn(TypstRenderer.prototype, "svg_data")
    .mockImplementationOnce(() => {
      throw new Error("renderer failure");
    });
  await expect(
    preview.svg({ mainContent: "Release resources" }),
  ).rejects.toThrow("renderer failure");
  expect(freeWorld).toHaveBeenCalledTimes(1);
  expect(freeSession).toHaveBeenCalledTimes(1);
  render.mockRestore();
  expect(await preview.svg({ mainContent: "Recovered render" })).toContain(
    "Recovered render",
  );
});
