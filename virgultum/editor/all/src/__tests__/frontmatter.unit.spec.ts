// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { StoreExtensionManager } from "../ext-loader/index.js";
import { getInternalStoreExtensions } from "../extensions/store.js";
import { MyoxusSchemas } from "../schemas.js";
import { ParagraphBlockModel } from "@virgultum/model";
import { Schema } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownTransformer } from "@virgultum/widget-linked-doc";
import { parseMatter } from "../../../widgets/linked-doc/src/transformers/utils.js";

const frontmatter = (matter: string) => `---\n${matter}\n---\n# Body\n`;

describe("Markdown import frontmatter", () => {
  it("preserves scalar text and the original matter and document body", () => {
    const matter =
      "title: 0123\nfavorite: true\ndate: 2026-10-03\ntag: null\ntags: [yes, 42]";
    expect(parseMatter(frontmatter(matter))).toEqual({
      matter: `\n${matter}\n`,
      body: "\n# Body\n",
      metadata: {
        title: "0123",
        favorite: "true",
        date: "2026-10-03",
        tag: "null",
        tags: ["yes", "42"],
      },
    });
  });

  it("keeps empty untagged values as text", () => {
    expect(
      parseMatter(
        frontmatter('empty:\nquoted: ""\nexplicit: !!str\nitems:\n  -\n  - ""'),
      )?.metadata,
    ).toEqual({ empty: "", quoted: "", explicit: "", items: ["", ""] });
  });

  it("only recognizes a document-leading header and whole delimiter lines", () => {
    expect(parseMatter(frontmatter("title: One---Two"))?.metadata).toEqual({
      title: "One---Two",
    });
    const matter = "description: |\n  ---\n  Literal delimiter";
    expect(parseMatter(frontmatter(matter))).toEqual({
      matter: `\n${matter}\n`,
      body: "\n# Body\n",
      metadata: { description: "---\nLiteral delimiter\n" },
    });
    expect(parseMatter("Body\n" + frontmatter("title: Later"))).toBeNull();
    expect(parseMatter("---\ntitle: One\n---inline\nBody")).toBeNull();
  });

  it("handles CRLF headers without changing document body line endings", () => {
    expect(parseMatter("---\r\ntitle: One\r\n---\r\nBody\r\n")).toEqual({
      matter: "\r\ntitle: One\r\n",
      body: "\r\nBody\r\n",
      metadata: { title: "One" },
    });
  });

  it("preserves nested values, aliases and literal merge keys", () => {
    const metadata = parseMatter(
      frontmatter(
        "tags: &tags [one, two]\ncopy: *tags\nbase: &base {title: One}\nnext: {<<: *base}\ndescription: |\n  First\n  Second",
      ),
    )?.metadata;
    expect(metadata).toEqual({
      tags: ["one", "two"],
      copy: ["one", "two"],
      base: { title: "One" },
      next: { "<<": { title: "One" } },
      description: "First\nSecond\n",
    });
    expect(metadata.copy).toBe(metadata.tags);
  });

  it.each([
    "---\n\n---\nBody",
    "---\nscalar\n---\nBody",
    "---\n- item\n---\nBody",
  ])("returns no frontmatter object for %s", (contents) =>
    expect(parseMatter(contents)).toBeNull(),
  );

  it.each([
    "title: first\ntitle: second",
    "title: *missing",
    "title: !custom text",
  ])(
    "rejects invalid metadata instead of accepting partial data: %s",
    (matter) => {
      expect(() => parseMatter(frontmatter(matter))).toThrow();
    },
  );

  it("keeps prototype-like keys as ordinary metadata", () => {
    const metadata = parseMatter(
      frontmatter("__proto__: {polluted: true}\nconstructor: example"),
    )?.metadata;
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(metadata.__proto__).toEqual({ polluted: "true" });
    expect(metadata.constructor).toBe("example");
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
  });

  it("bounds recursive alias expansion", () => {
    const aliases = (name: string) =>
      Array.from({ length: 10 }, () => `*${name}`).join(", ");
    expect(() =>
      parseMatter(
        frontmatter(
          `a: &a [one, two]\nb: &b [${aliases("a")}]\nc: [${aliases("b")}]`,
        ),
      ),
    ).toThrow(/alias count/i);
  });
});

describe("Frontmatter consumption by the Markdown document importer", () => {
  const extensions = new StoreExtensionManager(
    getInternalStoreExtensions(),
  ).get("store");
  const schema = new Schema().register(MyoxusSchemas);
  let collection: TestWorkspace;

  beforeEach(() => {
    collection = new TestWorkspace();
    collection.storeExtensions = extensions;
    collection.meta.initialize();
  });

  afterEach(() => {
    collection.forceStop();
    collection.dispose();
  });

  it("imports explicit types, literal titles and delimiter-containing content", async () => {
    const { docId } = await MarkdownTransformer.importMarkdownToDoc({
      collection,
      schema,
      extensions,
      markdown: frontmatter(
        "title: 0123---Release\ncreated: !!int 1735689600\nupdated: !!timestamp 2025-01-02\nfavorite: !!bool true\ntags: [0123, yes]",
      ),
    });
    expect(docId).toBeDefined();
    expect(collection.meta.getDocMeta(docId!)).toMatchObject({
      title: "0123---Release",
      createDate: 1735689600000,
      updatedDate: new Date("2025-01-02T00:00:00.000Z").getTime(),
      favorite: true,
      tags: ["0123", "yes"],
    });
    const store = collection.getDoc(docId!)!.getStore({ extensions });
    expect(
      store.getBlocksByFlavour("myoxus:paragraph").map(({ model }) => {
        if (!(model instanceof ParagraphBlockModel)) {
          throw new Error(
            "Paragraph flavour must materialize a paragraph model",
          );
        }
        return String(model.props.text);
      }),
    ).toContain("Body");
  });

  it("does not turn empty creation or modification dates into the Unix epoch", async () => {
    const { docId } = await MarkdownTransformer.importMarkdownToDoc({
      collection,
      schema,
      extensions,
      markdown: frontmatter('title: Empty dates\ncreated:\nupdated: "  "'),
    });
    expect(docId).toBeDefined();
    const meta = collection.meta.getDocMeta(docId!)!;
    expect(meta.title).toBe("Empty dates");
    expect(meta.createDate).toBeGreaterThan(0);
    expect(meta.updatedDate).not.toBe(0);
  });
});
