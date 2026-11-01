import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { generateI18nSource } from "./generate";
import { findTranslationSources } from "./source-files";

test("cleanup scans only live client/editor sources and retains linked source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "myoxus-i18n-sources-"));
  const included = [
    "client/web/top.ts",
    "client/web/deep/view.tsx",
    "client/web/component.jsx",
    "virgultum/editor/code.js",
  ];
  const excluded = [
    "client/web/.hidden.ts",
    "client/web/readme.md",
    "client/web/dist/generated.ts",
    "client/web/lib/generated.ts",
    "client/web/node_modules/pkg/index.ts",
    "virgultum/node_modules/pkg/index.ts",
    "client/libs/i18n/src/resources/en.ts",
    "client/libs/i18n/src/i18n.gen.ts",
    "server/tool.ts",
  ];
  try {
    for (const path of [...included, ...excluded]) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, "// source");
    }
    await symlink(join(root, included[0]), join(root, "client/web/linked.ts"));
    expect((await findTranslationSources(root)).sort()).toEqual(
      [...included, "client/web/linked.ts"]
        .map((path) => join(root, path))
        .sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("generateI18nSource", () => {
  test("emits plain, interpolated, plural and component contracts", () => {
    const source = generateI18nSource({
      plain: "Plain text",
      greeting: "Hello {{name}}",
      selected: "{{count}} selected",
      selected_one: "{{count}} item selected",
      selected_other: "{{count}} items selected",
      rich: "Open <1>{{name}}</1>",
      less: "<",
    });

    expect(source).toContain('["plain"](): string;');
    expect(source).toContain('readonly ["name"]: string;');
    expect(source).toContain('readonly ["count"]: string | number | bigint;');
    expect(source).toContain(
      '["rich"]: ComponentType<\n    TypedTransProps<\n      {',
    );
    expect(source).toContain('readonly ["1"]: JSX.Element;');
    expect(source).toContain('readonly ["dummyI18nTag"]: JSX.Element;');
  });

  test("is deterministic for the resource insertion order", () => {
    const resources = { first: "First", second: "Second" };

    expect(generateI18nSource(resources)).toBe(generateI18nSource(resources));
  });
});
