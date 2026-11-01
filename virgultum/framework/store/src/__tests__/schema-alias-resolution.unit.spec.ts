/**
 * Schema-level alias resolution tests.
 *
 * Invariants verified:
 *   - Schema.get() resolves legacy affine:* flavours to registered myoxus:* schemas
 *   - Schema.validate() accepts legacy affine:* flavours without throwing
 *   - Schema.isValid() returns true for legacy child/parent pairs
 *   - Block.flavour is normalized to canonical myoxus:* form even when Yjs data has affine:*
 *     (guards against event-dispatcher flavour filter mismatch on legacy documents)
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Block } from "../model/block/block.js";
import type { YBlock } from "../model/block/types.js";
import { Schema } from "../schema/schema.js";
import {
  NoteBlockSchema,
  ParagraphBlockSchema,
  RootBlockSchema,
} from "./test-schema.js";

function buildTestSchema(): Schema {
  const schema = new Schema();
  schema.register([RootBlockSchema, NoteBlockSchema, ParagraphBlockSchema]);
  return schema;
}

describe("Schema alias resolution", () => {
  it("get() with canonical myoxus:* key returns schema", () => {
    const schema = buildTestSchema();
    expect(schema.get("myoxus:paragraph")).toBeDefined();
    expect(schema.get("myoxus:note")).toBeDefined();
    expect(schema.get("myoxus:page")).toBeDefined();
  });

  it("get() with legacy affine:* key returns the same schema", () => {
    const schema = buildTestSchema();
    expect(schema.get("affine:paragraph")).toBe(schema.get("myoxus:paragraph"));
    expect(schema.get("affine:note")).toBe(schema.get("myoxus:note"));
    expect(schema.get("affine:page")).toBe(schema.get("myoxus:page"));
  });

  it("get() with unknown key returns undefined", () => {
    const schema = buildTestSchema();
    expect(schema.get("custom:unknown")).toBeUndefined();
  });

  it("validate() with legacy affine:* flavour does not throw", () => {
    const schema = buildTestSchema();
    // root block — no parent
    expect(() => schema.validate("affine:page")).not.toThrow();
    // note under page
    expect(() => schema.validate("affine:note", "affine:page")).not.toThrow();
    // paragraph under note
    expect(() =>
      schema.validate("affine:paragraph", "affine:note"),
    ).not.toThrow();
  });

  it("isValid() returns true for legacy child/parent pair", () => {
    const schema = buildTestSchema();
    expect(schema.isValid("affine:paragraph", "affine:note")).toBe(true);
    expect(schema.isValid("affine:note", "affine:page")).toBe(true);
  });

  it("isValid() returns false for invalid legacy pair", () => {
    const schema = buildTestSchema();
    // paragraph cannot be direct child of page
    expect(schema.isValid("affine:paragraph", "affine:page")).toBe(false);
  });

  it("safeValidate() returns true for valid legacy flavours", () => {
    const schema = buildTestSchema();
    expect(schema.safeValidate("affine:note", "affine:page")).toBe(true);
  });

  it("safeValidate() returns false for unknown legacy flavour", () => {
    const schema = buildTestSchema();
    expect(schema.safeValidate("affine:unknown-block", "affine:page")).toBe(
      false,
    );
  });
});

function makeYBlock(id: string, flavour: string): YBlock {
  const ydoc = new Y.Doc();
  const yBlock = ydoc.getMap(id) as YBlock;
  ydoc.transact(() => {
    yBlock.set("sys:id", id);
    yBlock.set("sys:flavour", flavour);
    yBlock.set("sys:children", new Y.Array());
    yBlock.set("sys:version", 1);
  });
  return yBlock;
}

describe("Block.flavour normalization from legacy Yjs data", () => {
  it("Block loaded with affine:paragraph in sys:flavour exposes myoxus:paragraph", () => {
    const schema = buildTestSchema();
    const yBlock = makeYBlock("block-1", "affine:paragraph");
    const block = new Block(schema, yBlock);
    expect(block.flavour).toBe("myoxus:paragraph");
  });

  it("Block loaded with myoxus:paragraph in sys:flavour is unchanged", () => {
    const schema = buildTestSchema();
    const yBlock = makeYBlock("block-2", "myoxus:paragraph");
    const block = new Block(schema, yBlock);
    expect(block.flavour).toBe("myoxus:paragraph");
  });
});
