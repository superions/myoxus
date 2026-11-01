// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { describe, expect, test, vi } from "vitest";

import {
  parseMindmapXml,
  parseMindmapXml as parseForeignMindmapXml,
  MindmapXmlError,
  MINDMAP_XML_LIMITS,
} from "../../../../../../../virgultum/editor/blocks/mermaid/src/families/mindmap/import/parse-xml";

describe("mindmap XML import", () => {
  test("preserves FreeMind child order, entities, nesting and layout", () => {
    expect(
      parseMindmapXml(
        '<map><!-- metadata --><node TEXT="Root &amp; &#233;"><icon BUILTIN="yes"/><node TEXT="A" POSITION="left"><node TEXT="Nested"/></node><node TEXT="B" POSITION="right"/></node></map>',
      ).root,
    ).toEqual({
      text: "Root & é",
      children: [
        {
          text: "A",
          layoutType: "left",
          children: [{ text: "Nested", children: [] }],
        },
        { text: "B", layoutType: "right", children: [] },
      ],
    });
  });
  test("finds OPML body independently of optional head and preserves nesting", () => {
    for (const head of ["", "<head><title>Metadata</title></head>"]) {
      expect(
        parseMindmapXml(
          `<opml>${head}<body><outline text="Root"><outline text="A &quot;B&quot;"/><outline text="Group"><outline text="C"/></outline></outline></body></opml>`,
        ).root,
      ).toEqual({
        text: "Root",
        children: [
          { text: 'A "B"', children: [] },
          { text: "Group", children: [{ text: "C", children: [] }] },
        ],
      });
    }
  });
  test.each(['<map><node TEXT="First"/><node TEXT="Second"/></map>'])(
    "rejects malformed or unsupported structure %s",
    (xml) => {
      expect(() => parseMindmapXml(xml)).toThrow();
    },
  );
  test("reports format, missing labels and explicit semantic losses without XML payloads", () => {
    const result = parseForeignMindmapXml(
      '<map><node TEXT="R" LINK="https://example.invalid"><icon BUILTIN="yes"/><richcontent TYPE="NODE"><html/></richcontent><richcontent TYPE="NOTE"><html/></richcontent><node TEXT="A" POSITION="left"/></node></map>',
    );
    expect(result.format).toBe("mm");
    expect(result.nodeCount).toBe(2);
    expect(result.root.children[0]).toEqual({
      text: "A",
      children: [],
      layoutType: "left",
    });
    expect(
      result.losses.map((loss) => [loss.kind, loss.field, loss.firstNode]),
    ).toEqual([
      ["link", "LINK", 1],
      ["icon", "icon", 1],
      ["richtext", "richcontent:NODE", 1],
      ["note", "richcontent:NOTE", 1],
    ]);
    expect(
      parseForeignMindmapXml(
        '<opml><body><outline text="R" url="x" _note="n"/></body></opml>',
      ).losses.map((loss) => loss.kind),
    ).toEqual(["link", "note"]);
    let failure: unknown;
    try {
      parseForeignMindmapXml(
        '<map><node TEXT="R"><node TEXT=" "/></node></map>',
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MindmapXmlError);
    expect(failure).toMatchObject({
      code: "label",
      format: "mm",
      node: 2,
      position: "1/1",
    });
    expect(String(failure)).not.toContain("<map>");
    expect(
      parseMindmapXml('<map><node TEXT="XML root determines format"/></map>')
        .root.text,
    ).toBe("XML root determines format");
  });
  test("enforces inclusive XML budgets and rejects declarations before DOM parsing", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    try {
      expect(() =>
        parseForeignMindmapXml(
          '<!DOCTYPE map [<!ENTITY bomb "x">]><map><node TEXT="R"/></map>',
        ),
      ).toThrowError(MindmapXmlError);
      expect(parse).not.toHaveBeenCalled();
      const small = '<map><node TEXT="é"/></map>';
      const bytes = new TextEncoder().encode(small).byteLength;
      expect(
        parseForeignMindmapXml(small, { ...MINDMAP_XML_LIMITS, bytes }).root
          .text,
      ).toBe("é");
      parse.mockClear();
      expect(() =>
        parseForeignMindmapXml(small, {
          ...MINDMAP_XML_LIMITS,
          bytes: bytes - 1,
        }),
      ).toThrowError(expect.objectContaining({ code: "bytes" }));
      expect(parse).not.toHaveBeenCalled();
      const wide = (count: number) =>
        `<map><node TEXT="R">${'<node TEXT="A"/>'.repeat(count - 1)}</node></map>`;
      expect(parseForeignMindmapXml(wide(5000)).nodeCount).toBe(5000);
      expect(() => parseForeignMindmapXml(wide(5001))).toThrowError(
        expect.objectContaining({ code: "nodes", limit: 5000 }),
      );
      const deep = (depth: number) =>
        `<map>${'<node TEXT="A">'.repeat(depth)}${"</node>".repeat(depth)}</map>`;
      expect(parseForeignMindmapXml(deep(128)).depth).toBe(128);
      expect(() => parseForeignMindmapXml(deep(129))).toThrowError(
        expect.objectContaining({ code: "depth", limit: 128 }),
      );
      const labelled = (length: number) =>
        `<map><node TEXT="${"😀".repeat(length)}"/></map>`;
      expect(parseForeignMindmapXml(labelled(8000)).root.text).toBe(
        "😀".repeat(8000),
      );
      expect(() => parseForeignMindmapXml(labelled(8001))).toThrowError(
        expect.objectContaining({ code: "label-codepoints", limit: 8000 }),
      );
      const envelope = "<map><!--",
        suffix = '--><node TEXT="R"/></map>';
      const maximum =
        envelope +
        " ".repeat(MINDMAP_XML_LIMITS.bytes - envelope.length - suffix.length) +
        suffix;
      expect(parseForeignMindmapXml(maximum).nodeCount).toBe(1);
      parse.mockClear();
      expect(() => parseForeignMindmapXml(maximum + " ")).toThrowError(
        expect.objectContaining({ code: "bytes" }),
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
