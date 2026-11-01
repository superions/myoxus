import type { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import { MyoxusSchemas } from "@virgultum/editor/schemas";
import { ZipTransformer } from "@virgultum/editor/widgets/linked-doc";
import type { PointLocation } from "@virgultum/global/gfx";
import { Schema } from "@virgultum/store";
import { beforeEach, expect, test } from "vitest";
import { Text } from "yjs";

import { Zip } from "../../../../editor/widgets/linked-doc/src/transformers/utils.js";

import { wait } from "../utils/common.js";
import { setupEditor } from "../utils/setup.js";

const excludes = new Set([
  "shape-textBound",
  "externalXYWH",
  "connector-text",
  "connector-labelXYWH",
]);

const fieldChecker: Record<string, (value: any) => boolean> = {
  "connector-path": (value: PointLocation[]) => {
    return value.length > 0;
  },
  xywh: (value: string) => {
    return value.match(xywhPattern) !== null;
  },
};

const skipFields = new Set(["_lastXYWH"]);

const snapshotTest = async (snapshotFile: Blob, elementsCount: number) => {
  const transformer = ZipTransformer;
  const schema = new Schema();
  schema.register(MyoxusSchemas);

  const [newDoc] = await transformer.importDocs(
    window.editor.doc.workspace,
    schema,
    snapshotFile,
  );

  if (!newDoc) {
    throw new Error("Failed to import snapshot");
  }

  editor.doc = newDoc;
  await wait();

  const surface = newDoc.getModelsByFlavour(
    "myoxus:surface",
  )[0] as SurfaceBlockModel;
  const surfaceElements = [...surface["_elementModels"]].map(
    ([_, { model }]) => model,
  );

  expect(surfaceElements.length).toBe(elementsCount);

  surfaceElements.forEach((element) => {
    const type = element.type;

    for (const field in element) {
      const value = element[field as keyof typeof element];
      const typeField = `${type}-${field}`;

      if (excludes.has(`${type}-${field}`) || excludes.has(field)) {
        return;
      }

      if (skipFields.has(field)) {
        return;
      }

      if (fieldChecker[typeField] || fieldChecker[field]) {
        const checker = fieldChecker[typeField] || fieldChecker[field];
        expect(checker(value)).toBe(true);
        return;
      }

      expect(
        value,
        `type: ${element.type} field: "${field}"`,
      ).not.toBeUndefined();
      expect(value, `type: ${element.type} field: "${field}"`).not.toBeNull();
      expect(value, `type: ${element.type} field: "${field}"`).not.toBeNaN();
    }
  });
};

beforeEach(async () => {
  const cleanup = await setupEditor("page");

  return cleanup;
});

const xywhPattern = /\[(\s*-?\d+(\.\d+)?\s*,){3}(\s*-?\d+(\.\d+)?\s*)\]/;

test("imports a generated canvas archive without bundled artwork", async () => {
  const surfaceId = doc.addBlock("myoxus:surface", {}, doc.root!.id);
  const surface = doc.getBlock(surfaceId)!.model as SurfaceBlockModel;
  const first = surface.addElement({
    type: "shape",
    xywh: "[0,0,120,80]",
    text: new Text("Start"),
  });
  const second = surface.addElement({
    type: "shape",
    xywh: "[240,0,120,80]",
    text: new Text("Finish"),
  });
  surface.addElement({
    type: "connector",
    source: { id: first },
    target: { id: second },
  });
  const snapshot = window.job.docToSnapshot(doc);
  expect(snapshot).not.toBeNull();
  const zip = new Zip();
  await zip.file("neutral.snapshot.json", JSON.stringify(snapshot));
  await snapshotTest(await zip.generate(), 3);
  const imported = editor.doc.getModelsByFlavour(
    "myoxus:surface",
  )[0] as SurfaceBlockModel;
  const elements = [...imported["_elementModels"].values()].map(
    ({ model }) => model,
  );
  const shapes = elements.filter((element) => element.type === "shape");
  expect(
    shapes
      .map((shape) => String((shape as unknown as { text: Text }).text))
      .sort(),
  ).toEqual(["Finish", "Start"]);
  const connector = elements.find(
    (element) => element.type === "connector",
  ) as unknown as { source: { id: string }; target: { id: string } };
  expect(new Set([connector.source.id, connector.target.id])).toEqual(
    new Set(shapes.map((shape) => shape.id)),
  );
});
