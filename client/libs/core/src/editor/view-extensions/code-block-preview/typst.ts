// SPDX-License-Identifier: MIT

import initRenderer, {
  TypstRendererBuilder,
  type TypstRenderer,
} from "@myriaddreamin/typst-ts-renderer";
import initCompiler, {
  TypstCompilerBuilder,
  type ProxyContext,
  type TypstCompiler,
} from "@myriaddreamin/typst-ts-web-compiler";

import { TYPST_FONT_URLS } from "./typst-fonts";

const compilerWasmUrl = new URL(
  "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
  import.meta.url,
).toString();
const rendererWasmUrl = new URL(
  "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm",
  import.meta.url,
).toString();

type PackageSpec = { namespace: string; name: string; version: string };
type PackageFile = { bytes: Uint8Array; modified: Date };

async function createRuntime() {
  await Promise.all([
    initCompiler({ module_or_path: compilerWasmUrl }),
    initRenderer({ module_or_path: rendererWasmUrl }),
  ]);
  const fonts = await Promise.all(
    TYPST_FONT_URLS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Typst font unavailable: ${url} (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const files = new Map<string, PackageFile>();
  const packages = new Map<string, string>();
  const builder = new TypstCompilerBuilder();
  let builderMoved = false;
  let compiler: TypstCompiler | undefined;
  try {
    await builder.set_access_model(
      files,
      (path: string) => files.get(path)?.modified,
      (path: string) => files.has(path),
      (path: string) => path,
      (path: string) => files.get(path)?.bytes,
    );
    // The WASM resolver is synchronous. Retain Typst's preview registry and
    // in-memory package cache without introducing a JS archive implementation.
    await builder.set_package_registry(
      packages,
      function (this: ProxyContext, spec: PackageSpec) {
        if (
          spec.namespace !== "preview" ||
          !/^[a-z0-9][a-z0-9-]*$/.test(spec.name) ||
          !/^\d+\.\d+\.\d+$/.test(spec.version)
        )
          return undefined;
        const key = `${spec.name}-${spec.version}`;
        const cached = packages.get(key);
        if (cached) return cached;
        const request = new XMLHttpRequest();
        request.overrideMimeType("text/plain; charset=x-user-defined");
        request.open(
          "GET",
          `https://packages.typst.org/preview/${key}.tar.gz`,
          false,
        );
        request.send(null);
        if (request.status !== 200 || typeof request.response !== "string")
          return undefined;
        const root = `/@memory/fetch/packages/preview/${spec.name}/${spec.version}`;
        const entries = new Map<string, PackageFile>();
        this.untar(
          Uint8Array.from(request.response, (char) => char.charCodeAt(0)),
          (path: string, bytes: Uint8Array, modified: number) => {
            if (
              path.startsWith("/") ||
              path.includes("\\") ||
              path.includes("\0") ||
              path.split("/").includes("..")
            )
              throw new Error("Invalid Typst package path");
            entries.set(`${root}/${path}`, {
              bytes,
              modified: new Date(modified),
            });
          },
        );
        for (const [path, file] of entries) files.set(path, file);
        packages.set(key, root);
        return root;
      },
    );
    for (const font of fonts) await builder.add_raw_font(font);
    // build() consumes the builder even when the returned promise rejects.
    builderMoved = true;
    compiler = await builder.build();
    const renderer = await new TypstRendererBuilder().build();
    return createTypstPreview(compiler, renderer);
  } catch (error) {
    compiler?.free();
    throw error;
  } finally {
    if (!builderMoved) builder.free();
  }
}

/** One cached compiler serves synchronous, isolated SVG renders. */
export function createTypstPreview(
  compiler: TypstCompiler,
  renderer: TypstRenderer,
) {
  return {
    async svg({ mainContent }: { mainContent: string }): Promise<string> {
      const mainPath = "/tmp/myoxus-preview.typ";
      compiler.add_source(mainPath, mainContent);
      let world: ReturnType<TypstCompiler["snapshot"]> | undefined;
      try {
        world = compiler.snapshot(undefined, mainPath, undefined);
        const result = world.get_artifact(0, 2) as {
          result?: Uint8Array;
          diagnostics?: string[];
          hasError?: boolean;
        };
        if (result.hasError || !result.result) {
          throw new Error(
            `Typst compilation failed:\n${result.diagnostics?.join("\n") || "No vector output"}`,
          );
        }
        const session = renderer.create_session();
        try {
          renderer.manipulate_data(session, "reset", result.result);
          return renderer.svg_data(session);
        } finally {
          session.free();
        }
      } finally {
        world?.free();
        compiler.unmap_shadow(mainPath);
      }
    },
  };
}

let runtimePromise: ReturnType<typeof createRuntime> | null = null;

export async function ensureTypstReady() {
  await getTypst();
}

export function getTypst() {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

export { TYPST_FONT_URLS };
