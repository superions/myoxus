/**
 * Yjs upgrade compatibility tests — P-DEPS-VIRG-A-01-T
 *
 * Covers the persisted wire contract of patched Yjs 13.6.32.
 * Runtime entry-point checks belong to yjs.compat.
 *  2. Doc state vector encode/decode round-trip
 *  3. Update merging across two independent docs
 *  4. Transaction grouping and observe integrity
 *  5. Remote attribute restoration after an XmlText change/delete/undo (#757)
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";

// Deterministic uint53 generation and CJS/ESM/source listener lifecycles are
// owned once by yjs.compat (build/scripts/ci/test-yjs-runtime.mjs).

// ---------------------------------------------------------------------------
// INV-YJS-02: State vector encode/decode round-trip must be lossless
// ---------------------------------------------------------------------------
describe("INV-YJS-02: state vector round-trip", () => {
  test("encodeStateVector → decodeStateVector is identity", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("data");
    doc.transact(() => {
      map.set("foo", "bar");
      map.set("count", 42);
    });

    const sv = Y.encodeStateVector(doc);
    const decoded = Y.decodeStateVector(sv);
    expect(decoded.size).toBeGreaterThan(0);
    expect(decoded.has(doc.clientID)).toBe(true);
  });

  test("encodeStateAsUpdate → applyUpdate reproduces exact state", () => {
    const docA = new Y.Doc();
    docA.getMap("m").set("hello", "world");
    docA.getMap("m").set("num", 99);

    const update = Y.encodeStateAsUpdate(docA);

    const docB = new Y.Doc();
    Y.applyUpdate(docB, update);

    expect(docB.getMap("m").get("hello")).toBe("world");
    expect(docB.getMap("m").get("num")).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// INV-YJS-03: Two-peer sync — incremental update exchange
// ---------------------------------------------------------------------------
describe("INV-YJS-03: incremental sync between two docs", () => {
  test("peer A changes propagate to peer B via diff update", () => {
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();

    // Initial sync: A → B
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA));

    // A makes a change
    peerA.getMap("shared").set("key", "value-from-A");

    // Compute diff and apply to B
    const svB = Y.encodeStateVector(peerB);
    const diffUpdate = Y.encodeStateAsUpdate(peerA, svB);
    Y.applyUpdate(peerB, diffUpdate);

    expect(peerB.getMap("shared").get("key")).toBe("value-from-A");
  });

  test("concurrent edits merge without data loss", () => {
    const peerA = new Y.Doc();
    const peerB = new Y.Doc();

    // Bootstrap both from empty state
    const initialUpdate = Y.encodeStateAsUpdate(peerA);
    Y.applyUpdate(peerB, initialUpdate);

    // Both make independent edits
    peerA.getMap("data").set("fromA", 1);
    peerB.getMap("data").set("fromB", 2);

    // Exchange updates
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA));
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB));

    // Both peers converge
    expect(peerA.getMap("data").get("fromA")).toBe(1);
    expect(peerA.getMap("data").get("fromB")).toBe(2);
    expect(peerB.getMap("data").get("fromA")).toBe(1);
    expect(peerB.getMap("data").get("fromB")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// INV-YJS-04: Transaction observe — no phantom events after yjs upgrade
// ---------------------------------------------------------------------------
describe("INV-YJS-04: transaction observe integrity", () => {
  test("observe fires exactly once per transaction", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("m");
    const events: number[] = [];

    map.observe(() => {
      events.push(events.length);
    });

    doc.transact(() => {
      map.set("a", 1);
      map.set("b", 2);
      map.set("c", 3);
    });

    // One transaction → one observe event
    expect(events.length).toBe(1);
  });

  test("Y.Text insert/delete preserves content integrity", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");

    text.insert(0, "Hello, World!");
    expect(text.toString()).toBe("Hello, World!");

    text.delete(7, 5); // delete "World"
    expect(text.toString()).toBe("Hello, !");

    text.insert(7, "Yjs");
    expect(text.toString()).toBe("Hello, Yjs!");
  });
});

describe("INV-YJS-05: XmlText undo state converges remotely", () => {
  test.each([
    ["v1", Y.encodeStateAsUpdate, Y.applyUpdate],
    ["v2", Y.encodeStateAsUpdateV2, Y.applyUpdateV2],
  ] as const)(
    "%s update preserves restored attributes after setAttribute, delete and undo",
    (_version, encode, apply) => {
      const source = new Y.Doc();
      const root = source.get("sharedRoot", Y.XmlText);
      const button = new Y.XmlText();
      button.setAttribute("type", "button");
      button.setAttribute("test", true);
      button.insert(0, "Click me");
      root.insertEmbed(0, button);

      const undoManager = new Y.UndoManager(root);
      undoManager.stopCapturing();
      button.setAttribute("type", "paragraph");
      root.delete(0, 1);
      undoManager.undo();

      const remote = new Y.Doc();
      apply(remote, encode(source));
      const restored = remote.get("sharedRoot", Y.XmlText).toDelta()[0]?.insert;

      expect(restored).toBeInstanceOf(Y.XmlText);
      expect((restored as Y.XmlText).getAttributes()).toEqual({
        test: true,
        type: "button",
      });
    },
  );
});
