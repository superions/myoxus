// SPDX-License-Identifier: AGPL-3.0-or-later

import mermaid from "mermaid";
import { expect, test, vi } from "vitest";
import {
  adaptC4NativeRender,
  isC4NativeRenderDb,
} from "../families/c4/native-render-projection.js";
import { renderMermaidSvg } from "../renderer.js";

const source = `C4Container
title Diagram title
accTitle: Accessible title
Boundary(team, "Team") {
Container(api, "API", "Rust")
}
UpdateElementStyle(api, $techn="Updated")
Person(user, "User")
Rel(user, api, "Uses")`;

test("projects actual native metadata and Technology without changing the DB records", async () => {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (!isC4NativeRenderDb(db)) throw new Error("Expected public C4 DB");
  const originals = {
    getTitle: db.getTitle,
    getAccTitle: db.getAccTitle,
    getC4ShapeArray: db.getC4ShapeArray,
    getC4Shape: db.getC4Shape,
    getRels: db.getRels,
  };
  const native = db.getC4Shape("api")!;
  expect(native.techn).toBe("Updated");
  expect(db.getTitle()).toBe("Accessible title");
  const restore = adaptC4NativeRender(source, db);
  try {
    expect(db.getTitle()).toBe("Diagram title");
    expect(db.getAccTitle()).toBe("Accessible title");
    const shape = db
      .getC4ShapeArray("team")
      .find((shape) => shape.alias === "api")!;
    expect(shape).toEqual({ ...native, techn: { text: "Updated" } });
    expect(db.getC4Shape("api")).toBe(shape);
    shape.x = 20;
    expect(db.getC4Shape("api")!.x).toBe(20);
    expect(native.x).not.toBe(20);
    const relation = db.getRels()[0];
    (relation.label as { text: string }).text = "render-only prefix";
    expect((db.getRels()[0].label as { text: string }).text).toBe("Uses");
  } finally {
    restore();
  }
  for (const [key, getter] of Object.entries(originals))
    expect(db[key as keyof typeof originals]).toBe(getter);
  expect(native.techn).toBe("Updated");
});

test("the serialized renderer restores public C4 getters after failure and accepts the next turn", async () => {
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(source);
  if (!isC4NativeRenderDb(db)) throw new Error("Expected public C4 DB");
  const originalTitle = db.getTitle,
    originalShape = db.getC4Shape;
  let calls = 0;
  const render = vi.spyOn(mermaid, "render").mockImplementation(async () => {
    expect(db.getTitle()).toBe("Diagram title");
    expect(db.getAccTitle()).toBe("Accessible title");
    expect(db.getC4Shape("api")!.techn).toEqual({ text: "Updated" });
    if (++calls === 1) throw new Error("injected native render failure");
    return { svg: "<svg></svg>", diagramType: "c4" };
  });
  try {
    await expect(renderMermaidSvg(source)).rejects.toThrow(
      "injected native render failure",
    );
    expect(db.getTitle).toBe(originalTitle);
    expect(db.getC4Shape).toBe(originalShape);
    await expect(renderMermaidSvg(source)).resolves.toEqual({
      svg: "<svg></svg>",
    });
    expect(db.getTitle).toBe(originalTitle);
    expect(db.getC4Shape).toBe(originalShape);
  } finally {
    render.mockRestore();
  }
});
