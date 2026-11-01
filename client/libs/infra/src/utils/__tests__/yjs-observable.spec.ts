import { describe, expect, test } from "vitest";
import { Array as YArray, Doc as YDoc, Map as YMap } from "yjs";

import { yjsGetPath, yjsObservePath } from "../yjs-observable";

describe("yjs observable", () => {
  test("basic", async () => {
    const ydoc = new YDoc();
    let currentValue: any = false;
    yjsGetPath(ydoc.getMap("foo"), "key.subkey").subscribe(
      (v) => (currentValue = v),
    );
    expect(currentValue).toBe(undefined);

    ydoc.getMap("foo").set("key", new YMap([["subkey", "xxxzzz"]]));
    expect(currentValue).toBe("xxxzzz");

    (ydoc.getMap("foo").get("key") as YMap<string>).set("subkey", "yyy");
    expect(currentValue).toBe("yyy");

    (ydoc.getMap("foo").get("key") as YMap<string>).delete("subkey");
    expect(currentValue).toBe(undefined);

    (ydoc.getMap("foo").get("key") as YMap<string>).set("subkey", "yyy");
    ydoc.getMap("foo").delete("key");
    expect(currentValue).toBe(undefined);

    ydoc.getMap("foo").set("key", "text");
    expect(currentValue).toBe(undefined);
  });

  test("observe with path", async () => {
    const ydoc = new YDoc();

    /**
     * {
     *   metas: {
     *     pages: [
     *       {
     *         id: '1',
     *         title: 'page 1',
     *         tags: ['tag1', 'tag2']
     *       }
     *     ]
     *   }
     * }
     */

    let currentValue: any = false;
    let callbackCount = 0;

    yjsObservePath(ydoc.getMap("metas"), "pages.*.tags").subscribe((v) => {
      callbackCount++;
      currentValue = (v as any)
        .toJSON()
        .pages?.map((page: any) => ({ id: page.id, tags: page.tags ?? [] }));
    });

    expect(callbackCount).toBe(1);

    ydoc.getMap("metas").set("pages", new YArray<any>());

    expect(callbackCount).toBe(2);
    expect(currentValue).toStrictEqual([]);

    const pages = ydoc.getMap("metas").get("pages") as YArray<any>;
    pages.push([
      new YMap([
        ["id", "1"],
        ["title", "page 1"],
        ["tags", YArray.from(["tag1", "tag2"])],
      ]),
    ]);

    expect(callbackCount).toBe(3);
    expect(currentValue).toStrictEqual([{ id: "1", tags: ["tag1", "tag2"] }]);

    pages.get(0).set("title", "page 1*");

    expect(callbackCount).toBe(3); // no change

    pages.get(0).get("tags").push(["tag3"]);

    expect(callbackCount).toBe(4);
    expect(currentValue).toStrictEqual([
      { id: "1", tags: ["tag1", "tag2", "tag3"] },
    ]);

    ydoc.getMap("metas").set("otherMeta", "true");

    expect(callbackCount).toBe(4); // no change

    pages.push([
      new YMap([
        ["id", "2"],
        ["title", "page 2"],
      ]),
    ]);

    expect(callbackCount).toBe(5);
    expect(currentValue).toStrictEqual([
      { id: "1", tags: ["tag1", "tag2", "tag3"] },
      { id: "2", tags: [] },
    ]);

    pages.delete(0);

    expect(callbackCount).toBe(6);
    expect(currentValue).toStrictEqual([{ id: "2", tags: [] }]);
  });

  test("observe with wildcard path emits when a child map key is added", async () => {
    const ydoc = new YDoc();
    ydoc.getMap("metas").set("pages", new YArray<any>());
    const pages = ydoc.getMap("metas").get("pages") as YArray<any>;
    pages.push([
      new YMap([
        ["id", "doc-1"],
        ["title", "doc 1"],
      ]),
    ]);

    const snapshots: Array<Array<{ id: string; trash: boolean }>> = [];
    yjsObservePath(ydoc.getMap("metas"), "pages.*.trash").subscribe((v) => {
      snapshots.push(
        ((v as any).toJSON().pages ?? []).map((page: any) => ({
          id: page.id,
          trash: Boolean(page.trash),
        })),
      );
    });

    pages.get(0).set("trash", true);

    expect(snapshots).toStrictEqual([
      [{ id: "doc-1", trash: false }],
      [{ id: "doc-1", trash: true }],
    ]);
  });

  test("observe with wildcard path on an array emits when a child map key is added", async () => {
    const ydoc = new YDoc();
    const pages = new YArray<any>();
    ydoc.getMap("metas").set("pages", pages);
    pages.push([
      new YMap([
        ["id", "doc-1"],
        ["title", "doc 1"],
      ]),
    ]);

    const snapshots: Array<Array<{ id: string; trash: boolean }>> = [];
    yjsObservePath(pages, "*.trash").subscribe((v) => {
      snapshots.push(
        ((v as YArray<YMap<unknown>>).toJSON() ?? []).map((page: any) => ({
          id: page.id,
          trash: Boolean(page.trash),
        })),
      );
    });

    pages.get(0).set("trash", true);

    expect(snapshots).toStrictEqual([
      [{ id: "doc-1", trash: false }],
      [{ id: "doc-1", trash: true }],
    ]);
  });
});
