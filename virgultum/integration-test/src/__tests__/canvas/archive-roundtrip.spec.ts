// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import type { PointLocation } from "@virgultum/editor/global/gfx";
import { Zip, ZipTransformer } from "@virgultum/editor/interchange";
import { MyoxusSchemas } from "@virgultum/editor/schemas";
import { Schema } from "@virgultum/editor/store";
import { beforeEach, describe, expect, test } from "vitest";
import { Text } from "yjs";

import { flushFrame } from "../../harness/pointer.js";
import { getMountedSurface, mountTestSession } from "../../harness/session.js";

const XYWH_PATTERN = /\[(\s*-?\d+(\.\d+)?\s*,){3}(\s*-?\d+(\.\d+)?\s*)\]/;
const OPTIONAL_FIELDS = new Set([
  "shape-textBound",
  "externalXYWH",
  "connector-text",
  "connector-labelXYWH",
  "_lastXYWH",
]);

describe("canvas archive round-trip via @virgultum/editor/interchange", () => {
  beforeEach(async () => {
    return mountTestSession("edgeless");
  });

  test("exports and re-imports canvas shapes and connectors with valid remapped endpoints", async () => {
    const sourceSurface = getMountedSurface(window.doc, window.editor).model;
    const startId = sourceSurface.addElement({
      type: "shape",
      xywh: "[0,0,120,80]",
      text: new Text("Start"),
    });
    const finishId = sourceSurface.addElement({
      type: "shape",
      xywh: "[240,0,120,80]",
      text: new Text("Finish"),
    });
    sourceSurface.addElement({
      type: "connector",
      source: { id: startId },
      target: { id: finishId },
    });

    const snapshot = window.job.docToSnapshot(doc);
    expect(snapshot).not.toBeNull();

    const archive = new Zip();
    await archive.file("canvas.snapshot.json", JSON.stringify(snapshot));
    const archiveBlob = await archive.generate();

    const schema = new Schema().register(MyoxusSchemas);
    const [importedDoc] = await ZipTransformer.importDocs(
      window.editor.doc.workspace,
      schema,
      archiveBlob,
    );
    expect(importedDoc).toBeDefined();

    editor.doc = importedDoc!;
    await flushFrame();

    const importedSurface = importedDoc!.getModelsByFlavour(
      "myoxus:surface",
    )[0] as SurfaceBlockModel;
    const elements = [...importedSurface["_elementModels"].values()].map(
      ({ model }) => model,
    );
    expect(elements).toHaveLength(3);

    for (const element of elements) {
      for (const field of Object.keys(element)) {
        const key = `${element.type}-${field}`;
        if (OPTIONAL_FIELDS.has(key) || OPTIONAL_FIELDS.has(field)) continue;

        const value = element[field as keyof typeof element];
        if (key === "connector-path") {
          expect((value as unknown as PointLocation[]).length).toBeGreaterThan(
            0,
          );
        } else if (field === "xywh") {
          expect(String(value)).toMatch(XYWH_PATTERN);
        } else {
          expect(value, `${element.type}.${field}`).not.toBeUndefined();
          expect(value, `${element.type}.${field}`).not.toBeNull();
          expect(value, `${element.type}.${field}`).not.toBeNaN();
        }
      }
    }

    const shapes = elements.filter((el) => el.type === "shape");
    expect(
      shapes
        .map((shape) => String((shape as unknown as { text: Text }).text))
        .sort(),
    ).toEqual(["Finish", "Start"]);

    const connector = elements.find(
      (el) => el.type === "connector",
    ) as unknown as {
      source: { id: string };
      target: { id: string };
    };
    expect(new Set([connector.source.id, connector.target.id])).toEqual(
      new Set(shapes.map((s) => s.id)),
    );
  });
});
