import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { rspack, type Stats } from "@rspack/core";
import { expect, test } from "vitest";

import { productionCacheGroups } from "./cache-group";

// Compile the real registries: name-only assertions cannot detect an accidental
// recombination of dynamic grammars in the resulting chunk graph.
test("Shiki loads individual grammars and themes without losing highlighting", async () => {
  const root = mkdtempSync(join(tmpdir(), "myoxus-shiki-chunks-"));
  const entry = join(root, "entry.mjs");
  writeFileSync(
    entry,
    `
    import { createEditorHighlighterCore } from '@virgultum/components/syntax-highlighter';
    const languages = {
      javascript: () => import('@shikijs/langs/javascript'),
      python: () => import('@shikijs/langs/python'),
    };
    const themes = {
      'github-light': () => import('@shikijs/themes/github-light'),
      'github-dark': () => import('@shikijs/themes/github-dark'),
    };
    export async function highlight(lang, theme, code) {
      const highlighter = await createEditorHighlighterCore({
        langs: [(await languages[lang]()).default],
        themes: [(await themes[theme]()).default],
      });
      try { return highlighter.codeToTokensBase(code, { lang, theme }); }
      finally { highlighter.dispose(); }
    }
  `,
  );
  const compiler = rspack({
    mode: "production",
    target: "node",
    context: root,
    entry,
    resolve: {
      modules: [resolve("../../node_modules"), "node_modules"],
      extensionAlias: { ".js": [".ts", ".js"] },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: "builtin:swc-loader",
          options: { jsc: { parser: { syntax: "typescript" } } },
        },
      ],
    },
    output: {
      path: root,
      filename: "main.cjs",
      chunkFilename: "[name].cjs",
      library: { type: "commonjs2" },
    },
    optimization: {
      minimize: false,
      splitChunks: {
        minSize: 0,
        cacheGroups: { asyncVendor: productionCacheGroups.asyncVendor },
      },
    },
  });
  try {
    const stats = await new Promise<Stats>((accept, reject) => {
      compiler.run((error, result) =>
        error
          ? reject(error)
          : result
            ? accept(result)
            : reject(new Error("Missing stats")),
      );
    });
    expect(
      stats.hasErrors(),
      stats.toString({ all: false, errors: true }),
    ).toBe(false);
    const chunks =
      stats.toJson({ all: false, chunks: true, chunkModules: true }).chunks ??
      [];

    for (const name of [
      "langs-javascript",
      "langs-python",
      "themes-github-light",
      "themes-github-dark",
    ]) {
      const chunk = chunks.find((chunk) =>
        chunk.names?.includes(`npm-async-@shikijs-${name}`),
      );
      expect(chunk, name).toBeDefined();
      expect(chunk!.initial).toBe(false);
      const source = (chunk!.files ?? [])
        .map((file) => readFileSync(join(root, file), "utf8"))
        .join("\n");
      if (name === "langs-javascript")
        expect(source).not.toContain('scopeName: "source.python"');
    }
    const load = createRequire(entry);
    const { highlight } = load(join(root, "main.cjs"));
    for (const [lang, code] of [
      ["javascript", "const answer = 42;"],
      ["python", "answer = 42"],
    ]) {
      const light = await highlight(lang, "github-light", code);
      const dark = await highlight(lang, "github-dark", code);
      expect(
        light
          .flat()
          .map((token: { content: string }) => token.content)
          .join(""),
      ).toBe(code);
      expect(
        dark
          .flat()
          .map((token: { content: string }) => token.content)
          .join(""),
      ).toBe(code);
      expect(
        light.flat().map((token: { color: string }) => token.color),
      ).not.toEqual(dark.flat().map((token: { color: string }) => token.color));
    }
  } finally {
    await new Promise<void>((accept, reject) =>
      compiler.close((error) => (error ? reject(error) : accept())),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

// Keep the real fork/Facade/vendor closure in this compile. A synthetic canvas
// or a dynamic-import spelling check misses CSS moved into an initial group.
test("BPMN source startup excludes the lazy modeller's emitted JS and CSS", async () => {
  const root = mkdtempSync(join(tmpdir(), "myoxus-bpmn-chunks-"));
  const entry = join(root, "entry.mjs");
  writeFileSync(
    join(root, "ordinary.css"),
    ":root { --ordinary-bundle-probe: 1; }",
  );
  writeFileSync(
    entry,
    `
    import './ordinary.css';
    import { createBlankBpmnSource } from '@myoxus/bpmn-editor/source';
    export const source = () => createBlankBpmnSource();
    export const open = () => import(/* webpackChunkName: "bpmn-modeller" */ '@myoxus/bpmn-editor');
  `,
  );
  const compiler = rspack({
    mode: "production",
    target: "web",
    context: root,
    entry,
    experiments: { css: true },
    resolve: {
      extensions: [".ts", ".tsx", ".mjs", ".js", ".json"],
      modules: [resolve("../../node_modules"), "node_modules"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true, decorators: true },
              transform: {
                react: { runtime: "automatic" },
                legacyDecorator: true,
              },
            },
          },
        },
        { test: /\.css$/, type: "css" },
        { test: /\.(svg|png|woff2?|ttf|otf)$/, type: "asset/resource" },
      ],
    },
    output: { path: root, filename: "main.js", chunkFilename: "[name].js" },
    optimization: {
      minimize: false,
      splitChunks: {
        chunks: "all",
        minSize: 0,
        cacheGroups: {
          ...productionCacheGroups,
          vendor: { ...productionCacheGroups.vendor, chunks: "initial" },
        },
      },
    },
  });
  try {
    const stats = await new Promise<Stats>((accept, reject) =>
      compiler.run((error, result) =>
        error
          ? reject(error)
          : result
            ? accept(result)
            : reject(new Error("Missing stats")),
      ),
    );
    expect(
      stats.hasErrors(),
      stats.toString({ all: false, errors: true }),
    ).toBe(false);
    const chunks =
      stats.toJson({
        all: false,
        chunks: true,
        chunkModules: true,
        nestedModules: true,
      }).chunks ?? [];
    const initial = chunks.filter((chunk) => chunk.initial);
    const initialCss = initial
      .flatMap((chunk) => chunk.files ?? [])
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    expect(initialCss).toContain("ordinary-bundle-probe");
    expect(initialCss).not.toContain("react-flow");
    type EmittedModule = { name?: string; modules?: EmittedModule[] };
    const moduleNames = (modules: EmittedModule[]): string[] =>
      modules.flatMap((module) => [
        module.name ?? "",
        ...moduleNames(module.modules ?? []),
      ]);
    // Stats issuer paths describe why a shared module exists, not which code
    // was emitted in this chunk. Inspect owned modules, including concatenation.
    const initialNames = moduleNames(
      initial.flatMap((chunk) => chunk.modules ?? []),
    ).join("\n");
    expect(initialNames).not.toContain("bpmn-editor/src/modeller.tsx");
    expect(initialNames).not.toContain("bpmn-editor/src/editor/BpmnEditor.tsx");
    expect(initialNames).not.toContain("node_modules/react/");
    const lazy = chunks.filter((chunk) => !chunk.initial);
    expect(
      moduleNames(lazy.flatMap((chunk) => chunk.modules ?? [])).join("\n"),
    ).toContain("bpmn-editor/src/modeller.tsx");
    const lazyCss = lazy
      .flatMap((chunk) => chunk.files ?? [])
      .filter((file) => file.endsWith(".css"))
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    expect(lazyCss).toContain("react-flow");
    const allNames = moduleNames(
      chunks.flatMap((chunk) => chunk.modules ?? []),
    );
    for (const runtime of ["react", "react-dom", "@xyflow/react"]) {
      const roots = new Set(
        allNames.flatMap((name) => {
          const marker = `/node_modules/${runtime}/`;
          return name.includes(marker)
            ? [name.slice(0, name.lastIndexOf(marker)) + marker]
            : [];
        }),
      );
      expect(
        roots.size,
        `${runtime} runtime roots: ${[...roots].join(", ")}`,
      ).toBe(1);
    }
    expect(allNames.join("\n")).not.toMatch(
      /node_modules\/(?:@kie-tools|@patternfly|reactflow|monaco-editor)\//,
    );
  } finally {
    await new Promise<void>((accept, reject) =>
      compiler.close((error) => (error ? reject(error) : accept())),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

// Use real package bodies: grouping the scope can deliver widgets even when
// their modules are absent from the HTML entrypoint's initial chunks.
test("ordinary async Mantine delivery does not include chart or RichText runtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "myoxus-mantine-chunks-"));
  const entry = join(root, "entry.mjs");
  writeFileSync(
    entry,
    `export const controls = () => import('@mantine/core');
    export const charts = () => import('@mantine/charts');
    export const richText = () => import('@mantine/tiptap');`,
  );
  const compiler = rspack({
    mode: "production",
    target: "node",
    context: root,
    entry,
    resolve: { modules: [resolve("../../node_modules"), "node_modules"] },
    output: {
      path: root,
      filename: "main.cjs",
      chunkFilename: "[name].cjs",
      library: { type: "commonjs2" },
    },
    optimization: {
      minimize: false,
      splitChunks: {
        minSize: 0,
        cacheGroups: { asyncVendor: productionCacheGroups.asyncVendor },
      },
    },
  });
  try {
    const stats = await new Promise<Stats>((accept, reject) =>
      compiler.run((error, stats) =>
        error
          ? reject(error)
          : stats
            ? accept(stats)
            : reject(new Error("Missing stats")),
      ),
    );
    expect(
      stats.hasErrors(),
      stats.toString({ all: false, errors: true }),
    ).toBe(false);
    const chunks = stats.toJson({ all: false, chunks: true }).chunks ?? [];
    const controls = chunks.find((chunk) =>
      chunk.names?.includes("npm-async-@mantine"),
    );
    const charts = chunks.find((chunk) =>
      chunk.names?.includes("npm-async-@mantine-charts"),
    );
    const richText = chunks.find((chunk) =>
      chunk.names?.includes("npm-async-@mantine-tiptap"),
    );
    expect(controls).toBeDefined();
    expect(charts).toBeDefined();
    expect(richText).toBeDefined();
    const bodies = (controls!.files ?? [])
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    expect(bodies).not.toContain("Sparkline");
    expect(bodies).not.toContain("RichTextEditor");
    const load = createRequire(entry)(join(root, "main.cjs"));
    expect(await load.controls()).toHaveProperty("Button");
    expect(await load.charts()).toHaveProperty("Sparkline");
    expect(await load.richText()).toHaveProperty("RichTextEditor");
  } finally {
    await new Promise<void>((accept, reject) =>
      compiler.close((error) => (error ? reject(error) : accept())),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
