// SPDX-License-Identifier: AGPL-3.0-or-later

import "fake-indexeddb/auto";
import { deleteDB, unwrap } from "idb";
import { expect, test, vi } from "vitest";
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  mergeUpdates,
} from "yjs";
import { IndexedDBDocStorage } from "./doc";

const value = (record: import("../../storage").DocRecord | null) => {
  if (!record) return null;
  const doc = new Doc();
  applyUpdate(doc, record.bin);
  const values = doc.getMap("test").toJSON();
  doc.destroy();
  return values;
};
async function fixture(merge?: (bins: Uint8Array[]) => Promise<Uint8Array>) {
  const id = crypto.randomUUID(),
    opts = { id, flavour: "doc-transaction-unit", type: "workspace" as const };
  const a = new IndexedDBDocStorage({
    ...opts,
    ...(merge ? { mergeUpdates: merge } : {}),
  });
  const b = new IndexedDBDocStorage(opts);
  a.connection.connect();
  b.connection.connect();
  await a.connection.waitForConnected();
  const source = new Doc();
  const update = (key: string) => {
    source.getMap("test").set(key, true);
    return { docId: id, bin: encodeStateAsUpdate(source) };
  };
  const seed = async () => {
    await b.pushDocUpdate(update("a"));
    await b.pushDocUpdate(update("b"));
  };
  const cleanup = async () => {
    source.destroy();
    a.connection.disconnect();
    b.connection.disconnect();
    await deleteDB(a.connection.dbName);
  };
  return { a, b, id, update, seed, cleanup };
}
test("an abandoned lease cannot block the cached root", async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.a.db.put("locks", {
      key: "workspace:" + f.id + ":update:" + f.id,
      lock: new Date(),
    });
    const record = await f.a.getDoc(f.id);
    expect(value(record)).toEqual({ a: true, b: true });
    expect(await f.a.db.count("updates")).toBe(0);
  } finally {
    await f.cleanup();
  }
});
test("current snapshots collect retired large values without losing delayed CRDT dependencies", async () => {
  const f = await fixture(),
    source = new Doc(),
    peer = new Doc(),
    late = new Doc();
  const payload = "whole XML payload ".repeat(2000);
  const heads = source.getMap<string>("heads");
  const links = source.getMap<string>("links");
  const persist = async () => {
    await f.a.pushDocUpdate({ docId: f.id, bin: encodeStateAsUpdate(source) });
    return (await f.a.getDoc(f.id))!;
  };
  try {
    heads.set("initial", payload);
    links.set("initial", "");
    const historical = encodeStateAsUpdate(source);
    applyUpdate(peer, historical);
    const initial = await persist();
    let parent = "initial";
    for (let i = 0; i < 24; i++) {
      const id = `edit-${i}`;
      source.transact(() => {
        heads.set(id, payload + i);
        links.set(id, parent);
        heads.delete(parent);
      });
      parent = id;
      await persist();
    }
    const compacted = (await f.a.getDoc(f.id))!;
    expect(compacted.bin.length - initial.bin.length).toBeLessThan(24 * 200);
    expect((await f.a.db.get("snapshots", f.id))!.bin).toEqual(compacted.bin);

    peer.getMap<string>("heads").set("offline", payload + "offline");
    peer.getMap<string>("links").set("offline", "initial");
    await f.b.pushDocUpdate({ docId: f.id, bin: encodeStateAsUpdate(peer) });
    // A second update can arrive before its same-client dependency. Compaction
    // must persist that pending state, not just the currently materialized map.
    late.getMap("late").set("value", "first");
    const first = encodeStateAsUpdate(late),
      state = encodeStateVector(late);
    late.getMap("late").set("value", "second");
    await f.b.pushDocUpdate({
      docId: f.id,
      bin: encodeStateAsUpdate(late, state),
    });
    await f.a.getDoc(f.id);
    await f.b.pushDocUpdate({ docId: f.id, bin: first });
    const restored = new Doc();
    try {
      applyUpdate(restored, (await f.a.getDoc(f.id))!.bin);
      expect(restored.getMap("heads").toJSON()).toEqual({
        [parent]: payload + 23,
        offline: payload + "offline",
      });
      expect(restored.getMap("links").toJSON()).toEqual({
        initial: "",
        ...Object.fromEntries(
          Array.from({ length: 24 }, (_, i) => [
            `edit-${i}`,
            i ? `edit-${i - 1}` : "initial",
          ]),
        ),
        offline: "initial",
      });
      expect(restored.getMap("late").toJSON()).toEqual({ value: "second" });
      applyUpdate(restored, historical);
      expect(restored.getMap("heads").has("initial")).toBe(false);
    } finally {
      restored.destroy();
    }
  } finally {
    source.destroy();
    peer.destroy();
    late.destroy();
    await f.cleanup();
  }
});
test("a concurrent append survives asynchronous compaction", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(async (bins) => {
    entered.resolve();
    await resume.promise;
    return mergeUpdates(bins);
  });
  let load: Promise<import("../../storage").DocRecord | null> | undefined;
  try {
    await f.seed();
    load = f.a.getDoc(f.id);
    await entered.promise;
    await f.b.pushDocUpdate(f.update("c"));
    resume.resolve();
    await load;
    expect(await f.a.db.count("updates")).toBe(1);
    expect(value(await f.b.getDoc(f.id))).toEqual({
      a: true,
      b: true,
      c: true,
    });
  } finally {
    resume.resolve();
    try {
      await load;
    } finally {
      await f.cleanup();
    }
  }
});
test("an older merge cannot overwrite a newer committed snapshot", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(async (bins) => {
    entered.resolve();
    await resume.promise;
    return mergeUpdates(bins);
  });
  let load: Promise<import("../../storage").DocRecord | null> | undefined;
  try {
    await f.seed();
    load = f.a.getDoc(f.id);
    await entered.promise;
    await f.b.pushDocUpdate(f.update("c"));
    expect(value(await f.b.getDoc(f.id))).toEqual({
      a: true,
      b: true,
      c: true,
    });
    resume.resolve();
    await load;
    expect(value(await f.b.getDoc(f.id))).toEqual({
      a: true,
      b: true,
      c: true,
    });
    expect(await f.a.db.count("updates")).toBe(0);
  } finally {
    resume.resolve();
    try {
      await load;
    } finally {
      await f.cleanup();
    }
  }
});
test("deletion during an asynchronous merge cannot resurrect cached bytes", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(async (bins) => {
    entered.resolve();
    await resume.promise;
    return mergeUpdates(bins);
  });
  let load: Promise<import("../../storage").DocRecord | null> | undefined;
  try {
    await f.seed();
    load = f.a.getDoc(f.id);
    await entered.promise;
    await f.b.deleteDoc(f.id);
    resume.resolve();
    await load;
    expect(await f.a.db.get("snapshots", f.id)).toBeUndefined();
    expect(await f.a.db.get("clocks", f.id)).toBeUndefined();
    expect(await f.a.db.count("updates")).toBe(0);
    expect(await f.a.getDoc(f.id)).toBeNull();
  } finally {
    resume.resolve();
    try {
      await load;
    } finally {
      await f.cleanup();
    }
  }
});
test("readonly merging does not mutate the captured records", async () => {
  const f = await fixture(),
    readonly = new IndexedDBDocStorage({
      id: f.id,
      flavour: "doc-transaction-unit",
      type: "workspace",
      readonlyMode: true,
    });
  readonly.connection.connect();
  try {
    await f.seed();
    expect(value(await readonly.getDoc(f.id))).toEqual({ a: true, b: true });
    expect(await f.a.db.get("snapshots", f.id)).toBeUndefined();
    expect(await f.a.db.count("updates")).toBe(2);
  } finally {
    readonly.connection.disconnect();
    await f.cleanup();
  }
});
test("concurrent writers retain both updates and a durable clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(1791982000000));
  const f = await fixture();
  try {
    const one = f.update("a"),
      two = f.update("b");
    await Promise.all([f.a.pushDocUpdate(one), f.b.pushDocUpdate(two)]);
    expect(value(await f.a.getDoc(f.id))).toEqual({ a: true, b: true });
    expect((await f.a.db.get("clocks", f.id))?.timestamp.getTime()).toBe(
      1791982000001,
    );
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});
test("a transaction abort rejects the writer and leaves neither bytes nor clock", async () => {
  const f = await fixture(),
    raw = unwrap(f.a.db),
    transact = raw.transaction.bind(raw);
  const spy = vi.spyOn(raw, "transaction").mockImplementation(((
    ...args: any[]
  ) => {
    const trx = (transact as any)(...args);
    queueMicrotask(() => trx.abort());
    return trx;
  }) as any);
  try {
    await expect(f.a.pushDocUpdate(f.update("a"))).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    spy.mockRestore();
    expect(await f.a.db.count("updates")).toBe(0);
    expect(await f.a.db.get("clocks", f.id)).toBeUndefined();
  } finally {
    spy.mockRestore();
    await f.cleanup();
  }
});

test("changed snapshot bytes invalidate compaction even at the same timestamp", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(async (bins) => {
    entered.resolve();
    await resume.promise;
    return mergeUpdates(bins);
  });
  let load: Promise<import("../../storage").DocRecord | null> | undefined;
  try {
    await f.seed();
    await f.b.getDoc(f.id);
    await f.b.pushDocUpdate(f.update("c"));
    load = f.a.getDoc(f.id);
    await entered.promise;
    const snapshot = (await f.b.db.get("snapshots", f.id))!;
    const replacement = { ...snapshot, bin: f.update("replacement").bin };
    await f.b.db.put("snapshots", replacement);
    resume.resolve();
    await load;
    expect(await f.a.db.get("snapshots", f.id)).toEqual(replacement);
    expect(await f.a.db.count("updates")).toBe(1);
  } finally {
    resume.resolve();
    try {
      await load;
    } finally {
      await f.cleanup();
    }
  }
});
test("changed captured update bytes stay queued instead of being deleted", async () => {
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const f = await fixture(async (bins) => {
    entered.resolve();
    await resume.promise;
    return mergeUpdates(bins);
  });
  let load: Promise<import("../../storage").DocRecord | null> | undefined;
  try {
    await f.seed();
    load = f.a.getDoc(f.id);
    await entered.promise;
    const update = (await f.b.db.getAll("updates"))[0];
    const replacement = { ...update, bin: f.update("replacement").bin };
    await f.b.db.put("updates", replacement);
    resume.resolve();
    await load;
    expect(await f.a.db.get("snapshots", f.id)).toBeUndefined();
    expect(await f.a.db.get("updates", [f.id, update.createdAt])).toEqual(
      replacement,
    );
    expect(await f.a.db.count("updates")).toBe(2);
  } finally {
    resume.resolve();
    try {
      await load;
    } finally {
      await f.cleanup();
    }
  }
});

test("a timestamp collision retry cannot recreate a concurrently deleted document", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(1791982000000));
  const f = await fixture();
  try {
    await f.a.pushDocUpdate(f.update("a"));
    const pending = f.a.pushDocUpdate(f.update("b"));
    const deleted = f.a.deleteDoc(f.id);
    await expect(pending).rejects.toHaveProperty("name", "DOC_DELETED");
    await deleted;
    expect(await f.a.db.count("updates")).toBe(0);
    expect(await f.a.db.get("clocks", f.id)).toBeUndefined();
    expect(await f.a.getDoc(f.id)).toBeNull();
  } finally {
    vi.useRealTimers();
    await f.cleanup();
  }
});
