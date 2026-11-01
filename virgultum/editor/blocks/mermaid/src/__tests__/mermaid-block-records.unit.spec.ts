// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";

import {
  resolveMermaidBlockSource,
  updateBlock,
  updateBlockConnection,
  addBlock,
  reorderBlockItem,
  deleteBlockComposite,
  deleteBlock,
  deleteBlockSpace,
  deleteBlockConnection,
  editBlockMetadata,
  editBlockComment,
  setBlockPadding,
  writeBlockPatches,
} from "../engine/block/index.js";
const rich =
  '---\r\ntitle: "Publication pipeline"\r\nconfig: {block: {padding: 12}, retained: "bytes"}\r\n---\r\nblock-beta\r\n  columns 4\r\n  %% input comment\r\n  input(["Request input"]):1\r\n  space\r\n  block:process["Processing"]:2\r\n    columns 2\r\n    %% local comment\r\n    validate{"Validate"}:1\r\n    transform[["Transform document"]]:1\r\n    space:1\r\n    block:store["Storage"]:1\r\n      columns 1\r\n      object[("Object store")]\r\n      audit((("Audit log")))\r\n    end\r\n  end\r\n  publish(["Publish"]):1\r\n  archive[("Archive")]:1\r\n  dispatch<["Dispatch"]>(right, down, right, x):1\r\n  input -- "request" --> validate %% connection comment\r\n  publish o-- "retained" --x archive\r\n  input ~~~ publish\r\n  classDef active fill:#dbeafe,stroke:#2563eb,color:#172554\r\n  class validate,transform active\r\n  style publish fill:#dcfce7,stroke:#16a34a,color:#052e16\r\n';
const model = (source = rich) => {
  const result = resolveMermaidBlockSource(source);
  expect(result.diagnostics.filter((d) => d.stage === "syntax")).toEqual([]);
  expect(result.model).not.toBeNull();
  return result.model!;
};
describe("Block record commands at the Source consumer boundary", () => {
  it("patches only label and true ID references, retaining comments and stable bindings through later edits", () => {
    const m = model(),
      a = m.nodes.find((n) => n.id === "input")!,
      untouched = m.nodes.find((n) => n.id === "archive")!,
      renamed = updateBlock(m, a.sourceKey, { label: "Incoming request" });
    expect(renamed.changed).toBe(true);
    expect(renamed.source).toBe(
      rich.replace('"Request input"', '"Incoming request"'),
    );
    const changed = updateBlock(renamed.model, a.sourceKey, { id: "intake" });
    expect(changed.changed).toBe(true);
    expect(changed.model.nodes.find((n) => n.id === "intake")!.sourceKey).toBe(
      a.sourceKey,
    );
    expect(changed.source).toContain(
      'intake -- "request" --> validate %% connection comment',
    );
    expect(changed.source).toContain("intake ~~~ publish");
    const inserted = addBlock(changed.model, {
      id: "lead",
      label: "Lead",
      before: changed.model.nodes.find((n) => n.id === "intake")!.recordKeys[0],
    });
    expect(inserted.changed).toBe(true);
    expect(
      inserted.model.nodes.find((n) => n.id === "archive")!.sourceKey,
    ).toBe(untouched.sourceKey);
    expect(inserted.model.comments).toEqual(changed.model.comments);
  });

  it("reparents all first-occurrence providers without changing unrelated implicit placement or class targets", () => {
    const m = model(
      'block-beta\nA["First"] --> B["Unrelated"]\nA["Effective"]:2\nclass A,B active\nblock:G\ncolumns 1\nend\nclassDef active fill:blue\n',
    );
    const a = m.nodes.find((n) => n.id === "A")!,
      b = m.nodes.find((n) => n.id === "B")!,
      g = m.groups[0]!;
    const changed = reorderBlockItem(m, a.sourceKey, g.bodyKey);
    expect(changed.status).toBe("changed");
    const moved = changed.model.nodes.find((n) => n.id === "A")!,
      other = changed.model.nodes.find((n) => n.id === "B")!;
    expect(moved).toMatchObject({
      sourceKey: a.sourceKey,
      parentKey: g.bodyKey,
      label: "Effective",
      span: 1,
    });
    expect(other).toMatchObject({
      sourceKey: b.sourceKey,
      parentKey: null,
      label: "Unrelated",
      span: 1,
      classes: ["active"],
    });
    expect(changed.model.edges[0]!.sourceKey).toBe(m.edges[0]!.sourceKey);
    const onlyChild = model("block-beta\nblock:G\nA\nend\nB\n");
    const unparented = reorderBlockItem(
      onlyChild,
      onlyChild.nodes.find((n) => n.id === "A")!.sourceKey,
      null,
    );
    expect(unparented.status).toBe("changed");
    expect(unparented.source).toContain("block:G\ncolumns auto\nend");
  });
  it("keeps parallel edge identities and exact notation through reconnect and label edits", () => {
    const m = model(
      'block-beta\nA B C\nA o-- "retained" --x B\nA ~~~ B\nA --> B\n',
    );
    const first = m.edges[0]!,
      changed = updateBlockConnection(m, first.sourceKey, {
        to: "C",
        label: "kept",
      });
    expect(changed.changed).toBe(true);
    expect(changed.source).toBe(
      'block-beta\nA B C\nA o-- "kept" --x C\nA ~~~ B\nA --> B\n',
    );
    expect(changed.model.edges.map((e) => e.sourceKey)).toEqual(
      m.edges.map((e) => e.sourceKey),
    );
    expect(
      updateBlockConnection(changed.model, first.sourceKey, { token: "~~~" })
        .changed,
    ).toBe(false);
    expect(
      updateBlockConnection(changed.model, first.sourceKey, {
        token: "~~~",
        confirmLabelLoss: true,
      }).changed,
    ).toBe(true);
    expect(
      updateBlockConnection(m, first.sourceKey, { token: "o~~~x" }).changed,
    ).toBe(false);
  });

  it("patches owned padding/comments and rejects stale, cancelled, readonly and overlapping writes", () => {
    const m = model(),
      changed = setBlockPadding(m, 18);
    expect(changed.changed).toBe(true);
    expect(changed.source).toBe(rich.replace("padding: 12", "padding: 18"));
    const comment = editBlockComment(changed.model, {
      key: changed.model.comments[1]!.sourceKey,
      text: "changed local comment",
    });
    expect(comment.changed).toBe(true);
    expect(comment.source).toBe(
      changed.source.replace("%% local comment", "%% changed local comment"),
    );
    for (const options of [
      { baseSource: "stale" },
      { readonly: true },
      { intent: "cancel" as const },
    ])
      expect(
        updateBlock(m, m.nodes[0]!.sourceKey, { label: "bad" }, options)
          .changed,
      ).toBe(false);
    expect(
      writeBlockPatches(m, [
        { range: { start: 0, end: 4 }, value: "x" },
        { range: { start: 2, end: 5 }, value: "y" },
      ]).changed,
    ).toBe(false);
  });
});

describe("Block destructive and implicit-placement commands", () => {
  it("deletes the final source item into a valid empty grid without a dummy child", () => {
    for (const source of [
      "block-beta\nA\n",
      "block-beta\nspace:0\n",
      "block-beta\nblock:G\ncolumns auto\nend\n",
    ]) {
      const m = model(source),
        result = m.nodes.length
          ? deleteBlock(m, m.nodes[0]!.sourceKey)
          : m.spaces.length
            ? deleteBlockSpace(m, m.spaces[0]!.sourceKey)
            : deleteBlockComposite(m, m.groups[0]!.sourceKey, {
                children: "delete",
              });
      expect(result.status).toBe("changed");
      expect(result.source).toBe("block-beta\ncolumns auto\n");
      expect(result.model.nodes).toEqual([]);
    }
  });

  it("preserves nested local columns on unwrap and removes contained CSS comments atomically", () => {
    const m = model(
        "block-beta\nblock:Outer\ncolumns 2\nblock:Inner\ncolumns 1\nA\nB\nend\nend\n",
      ),
      r = deleteBlockComposite(
        m,
        m.groups.find((g) => g.id === "Outer")!.sourceKey,
        { children: "retain" },
      );
    expect(r.status).toBe("changed");
    expect(r.model.groups[0]!.columns).toBe(1);
    expect(r.source).toContain("columns 1");
    expect(r.source).not.toContain("columns 2");
    const css = model(
        "block-beta\nclassDef active\n%% nested comment\nfill:blue\nA\n",
      ),
      d = editBlockMetadata(css, {
        key: css.styleStatements[0]!.sourceKey,
        kind: "classDef",
        targets: "active",
        value: "fill:blue",
        delete: true,
      });
    expect(d.status).toBe("changed");
    expect(d.source).toBe("block-beta\nA\n");
    const edge = model("block-beta\nA --> B %% edge comment\n"),
      de = deleteBlockConnection(edge, edge.edges[0]!.sourceKey);
    expect(de.status).toBe("changed");
    expect(de.model.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(de.model.edges).toEqual([]);
  });
});
