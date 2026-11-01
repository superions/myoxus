import { Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { ReactiveFlatYMap } from "../reactive/flat-native-y/index.js";
import {
  Boxed,
  createYProxy,
  popProp,
  stashProp,
  type Text,
} from "../reactive/index.js";
import { y2Native } from "../reactive/native-y.js";

describe("array", () => {
  test("push and splice", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray("arr");
    arr.push([0, 1, 2, 3, 4, 5]);

    const proxy = createYProxy(arr) as unknown[];
    expect(arr.toJSON()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(proxy).toEqual([0, 1, 2, 3, 4, 5]);

    proxy.push(6);
    expect(arr.toJSON()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(proxy).toEqual([0, 1, 2, 3, 4, 5, 6]);

    proxy.splice(1, 1);
    expect(arr.toJSON()).toEqual([0, 2, 3, 4, 5, 6]);
    expect(proxy).toEqual([0, 2, 3, 4, 5, 6]);

    proxy[0] = 2;
    expect(arr.toJSON()).toEqual([2, 2, 3, 4, 5, 6]);
    expect(proxy).toEqual([2, 2, 3, 4, 5, 6]);
  });

  test("shift and unshift", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray("arr");
    arr.push([0, 1, 2, 3, 4, 5]);

    const proxy = createYProxy(arr) as unknown[];
    expect(arr.toJSON()).toEqual([0, 1, 2, 3, 4, 5]);

    // Test shift
    const shifted = proxy.shift();
    expect(shifted).toBe(0);
    expect(arr.toJSON()).toEqual([1, 2, 3, 4, 5]);
    expect(proxy).toEqual([1, 2, 3, 4, 5]);

    const shifted2 = proxy.shift();
    expect(shifted2).toBe(1);
    expect(arr.toJSON()).toEqual([2, 3, 4, 5]);
    expect(proxy).toEqual([2, 3, 4, 5]);

    // Test shift on empty array
    const emptyArr = ydoc.getArray("empty");
    const emptyProxy = createYProxy(emptyArr) as unknown[];
    const emptyShifted = emptyProxy.shift();
    expect(emptyShifted).toBeUndefined();
    expect(emptyArr.toJSON()).toEqual([]);
    expect(emptyProxy).toEqual([]);

    // Test unshift
    proxy.unshift(-1, 0, 1);
    expect(arr.toJSON()).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(proxy).toEqual([-1, 0, 1, 2, 3, 4, 5]);

    // Test unshift with multiple items
    proxy.unshift(-3, -2);
    expect(arr.toJSON()).toEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5]);
    expect(proxy).toEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5]);
  });
});

describe("object", () => {
  test("deep", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap("map");
    const obj = new Y.Map();
    obj.set("foo", 1);
    map.set("obj", obj);
    map.set("num", 0);
    const map2 = new Y.Map();
    obj.set("map", map2);
    map2.set("foo", 40);

    const proxy = createYProxy<Record<string, any>>(map);

    expect(proxy.num).toBe(0);
    expect(proxy.obj.foo).toBe(1);
    expect(proxy.obj.map.foo).toBe(40);

    proxy.obj.bar = 100;
    expect(obj.get("bar")).toBe(100);

    proxy.obj2 = { foo: 2, bar: { num: 3 } };
    expect(map.get("obj2")).toBeInstanceOf(Y.Map);
    // @ts-expect-error ignore
    expect(map.get("obj2").get("bar").get("num")).toBe(3);

    proxy.obj2.bar.str = "hello";
    // @ts-expect-error ignore
    expect(map.get("obj2").get("bar").get("str")).toBe("hello");

    proxy.obj3 = {};
    const { obj3 } = proxy;
    obj3.id = "obj3";
    expect((map.get("obj3") as Y.Map<string>).get("id")).toBe("obj3");

    proxy.arr = [];
    expect(map.get("arr")).toBeInstanceOf(Y.Array);
    proxy.arr.push({ counter: 1 });
    expect((map.get("arr") as Y.Array<Y.Map<number>>).get(0)).toBeInstanceOf(
      Y.Map,
    );
    expect(
      (map.get("arr") as Y.Array<Y.Map<number>>).get(0).get("counter"),
    ).toBe(1);
  });

  test("with y text", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap("map");
    const inner = new Y.Map();
    map.set("inner", inner);
    const text = new Y.Text("hello");
    inner.set("text", text);

    const proxy = createYProxy<{ inner: { text: Text } }>(map);
    proxy.inner = { ...proxy.inner };
    expect(proxy.inner.text.yText).toBeInstanceOf(Y.Text);
    expect(proxy.inner.text.yText.toJSON()).toBe("hello");
  });

  test("with native wrapper", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap("map");
    const inner = new Y.Map();
    map.set("inner", inner);
    const native = new Boxed(["hello", "world"]);
    inner.set("native", native.yMap);

    const proxy = createYProxy<{
      inner: {
        native: Boxed<string[]>;
        native2: Boxed<number>;
      };
    }>(map);

    expect(proxy.inner.native.getValue()).toEqual(["hello", "world"]);

    proxy.inner.native.setValue(["hello", "world", "foo"]);
    expect(native.getValue()).toEqual(["hello", "world", "foo"]);
    // @ts-expect-error ignore
    expect(map.get("inner").get("native").get("value")).toEqual([
      "hello",
      "world",
      "foo",
    ]);

    const native2 = new Boxed(0);
    proxy.inner.native2 = native2;
    // @ts-expect-error ignore
    expect(map.get("inner").get("native2").get("value")).toBe(0);
    native2.setValue(1);
    // @ts-expect-error ignore
    expect(map.get("inner").get("native2").get("value")).toBe(1);
  });
});

describe("stash and pop", () => {
  test("object", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap("map");
    map.set("num", 0);

    const proxy = createYProxy<Record<string, any>>(map);

    expect(proxy.num).toBe(0);
    stashProp(map, "num");
    proxy.num = 1;
    expect(proxy.num).toBe(1);
    expect(map.get("num")).toBe(0);
    proxy.num = 2;
    popProp(map, "num");
    expect(map.get("num")).toBe(2);
  });

  test("array", () => {
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray("arr");
    arr.push([0]);

    const proxy = createYProxy<Record<string, any>>(arr);

    expect(proxy[0]).toBe(0);
    stashProp(arr, 0);
    proxy[0] = 1;
    expect(proxy[0]).toBe(1);
    expect(arr.get(0)).toBe(0);
    popProp(arr, 0);
    expect(arr.get(0)).toBe(1);
  });

  test("nested", () => {
    const ydoc = new Y.Doc();
    const map = ydoc.getMap("map");
    const arr = new Y.Array();
    map.set("arr", arr);
    arr.push([0]);

    const proxy = createYProxy<Record<string, any>>(map);

    expect(proxy.arr[0]).toBe(0);
    stashProp(arr, 0);
    proxy.arr[0] = 1;
    expect(proxy.arr[0]).toBe(1);
    expect(arr.get(0)).toBe(0);
    popProp(arr, 0);
    expect(arr.get(0)).toBe(1);
  });
});

test("flat", () => {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap("map");
  map.set("prop:col.a", 0);
  map.set("prop:col.b", 1);
  map.set("prop:col.c.d", 3);
  map.set("prop:col.c.e", 4);

  const reactive = new ReactiveFlatYMap(map, new Subject());
  const proxy = reactive.proxy as Record<string, any>;
  proxy.col.c.d = 200;
  expect(map.get("prop:col.c.d")).toBe(200);

  proxy.col.a = 200;
  expect(map.get("prop:col.a")).toBe(200);

  proxy.col.f = { a: 1 };
  expect(map.get("prop:col.f.a")).toBe(1);

  proxy.foo = "foo";
  expect(map.get("prop:foo")).toBe("foo");

  proxy.col.c = {
    d: 500,
  };
  expect(map.get("prop:col.c.d")).toBe(500);
  expect(map.get("prop:col.c.e")).toBe(undefined);

  proxy.col.a = 100;
  expect(map.get("prop:col.a")).toBe(100);
  proxy.col.c.e = 100;
  expect(map.get("prop:col.c.e")).toBe(100);

  const undoManager = new Y.UndoManager([map]);

  ydoc.transact(() => {
    map.set("prop:col.c.e", 200);
  }, undoManager);
  expect(proxy.col.c.e).toBe(200);

  ydoc.transact(() => {
    map.delete("prop:col.c.d");
  }, undoManager);
  expect(proxy.col.c.d).toBe(undefined);

  proxy.foo$.value = "foo2";
  expect(map.get("prop:foo")).toBe("foo2");

  proxy.col$.value = {
    a: 10,
    b: 20,
    c: {
      d: 30,
    },
  };
  expect(map.get("prop:col.a")).toBe(10);
  expect(map.get("prop:col.b")).toBe(20);
  expect(map.get("prop:col.c.d")).toBe(30);
});

// ---------------------------------------------------------------------------
// INV-BOXED-01: Boxed.is() storage-marker backward compatibility
// ---------------------------------------------------------------------------

describe("Boxed backward compat (BUG-04)", () => {
  // Helper: build a Y.Map attached to a doc with given type/value keys.
  // Y.Maps must be attached to a Y.Doc for .get() to work correctly.
  function makeBoxedYMap(typeMarker: string) {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Map<unknown>>("root");
    const inner = new Y.Map<unknown>();
    doc.transact(() => {
      root.set("boxed", inner);
      inner.set("type", typeMarker);
      inner.set("value", new Y.Map());
    });
    return root.get("boxed")!;
  }

  test("INV-BOXED-01: Boxed.is accepts canonical $virgultum:internal:native$ marker", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("test");
    const boxed = new Boxed(new Y.Map());
    root.set("elem", boxed.yMap);
    expect(boxed.yMap.get("type")).toBe("$virgultum:internal:native$");
    expect(Boxed.is(root.get("elem"))).toBe(true);
  });

  test("INV-BOXED-01: Boxed.is accepts legacy $blocksuite:internal:native$ marker", () => {
    const legacyYMap = makeBoxedYMap("$blocksuite:internal:native$");
    expect(Boxed.is(legacyYMap)).toBe(true);
  });

  test("INV-BOXED-02: y2Native returns Boxed instance for canonical marker", () => {
    // y2Native must reconstruct a Boxed (not plain object) for $virgultum:internal:native$
    const boxedYMap = makeBoxedYMap("$virgultum:internal:native$");
    const result = y2Native(boxedYMap);
    expect(result).toBeInstanceOf(Boxed);
    expect(typeof (result as Boxed).getValue).toBe("function");
  });

  test("INV-BOXED-02: y2Native returns Boxed instance for legacy marker", () => {
    // y2Native must also reconstruct a Boxed for the legacy $blocksuite:internal:native$ marker
    const legacyYMap = makeBoxedYMap("$blocksuite:internal:native$");
    const result = y2Native(legacyYMap);
    expect(result).toBeInstanceOf(Boxed);
    expect(typeof (result as Boxed).getValue).toBe("function");
  });

  // INV-BOXED-03/04: new Boxed(outerYMap) must return the INNER value via getValue(),
  // not the outer wrapper itself.

  test("INV-BOXED-03: new Boxed(legacyOuterMap).getValue() returns inner value, not the outer wrapper", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Map<unknown>>("root");
    const inner = new Y.Map<unknown>();
    const outer = new Y.Map<unknown>();
    doc.transact(() => {
      root.set("outer", outer);
      outer.set("type", "$blocksuite:internal:native$");
      outer.set("value", inner);
    });
    const reconstructed = new Boxed(
      root.get("outer") as unknown as Y.Map<unknown>,
    );
    expect(reconstructed.getValue()).toBe(inner);
  });

  test("INV-BOXED-04: new Boxed(canonicalOuterMap).getValue() returns inner value (regression guard)", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Map<unknown>>("root");
    const inner = new Y.Map<unknown>();
    const outer = new Y.Map<unknown>();
    doc.transact(() => {
      root.set("outer", outer);
      outer.set("type", "$virgultum:internal:native$");
      outer.set("value", inner);
    });
    const reconstructed = new Boxed(
      root.get("outer") as unknown as Y.Map<unknown>,
    );
    expect(reconstructed.getValue()).toBe(inner);
  });

  test("INV-BOXED-05: Boxed.is does not read detached Y.Maps", () => {
    const detached = new Y.Map();
    detached.set("type", "emoji");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(Boxed.is(detached)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("INV-BOXED-06: y2Native accepts plain object type fields without warning", () => {
    const doc = new Y.Doc();
    const root = doc.getMap<Y.Map<unknown>>("root");
    const plain = new Y.Map<unknown>();
    doc.transact(() => {
      root.set("emoji", plain);
      plain.set("type", "emoji");
      plain.set("name", "check");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(y2Native(root.get("emoji"))).toEqual({
        type: "emoji",
        name: "check",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
