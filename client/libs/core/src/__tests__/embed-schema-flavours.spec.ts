import { MyoxusSchemas } from "@virgultum/editor/schemas";
import { describe, expect, it } from "vitest";

describe("embed block schema flavours", () => {
  it("INV-EMBED-SCHEMA-01: every embed schema uses canonical myoxus flavours", () => {
    const embedFlavours = MyoxusSchemas.map((schema) => schema.model.flavour)
      .filter((flavour) => flavour.startsWith("myoxus:embed-"))
      .sort();

    expect(embedFlavours).toEqual([
      "myoxus:embed-figma",
      "myoxus:embed-github",
      "myoxus:embed-html",
      "myoxus:embed-iframe",
      "myoxus:embed-linked-doc",
      "myoxus:embed-loom",
      "myoxus:embed-synced-doc",
      "myoxus:embed-youtube",
    ]);
  });
});
