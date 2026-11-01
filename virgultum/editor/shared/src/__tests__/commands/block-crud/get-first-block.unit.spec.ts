/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";

import { getFirstBlockCommand } from "../../../commands/block-crud/get-first-content-block";
import { myoxus } from "../../../test-utils";

describe("commands/block-crud", () => {
  describe("getFirstBlockCommand", () => {
    it("should return null when root is not exists", () => {
      const host = myoxus`<myoxus-page></myoxus-page>`;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "content",
        root: undefined,
      });

      expect(firstBlock).toBeNull();
    });

    it("should return first block with content role when found", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1-1">First Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-1-2">Second Paragraph</myoxus-paragraph>
          </myoxus-note>
          <myoxus-note id="note-2">
            <myoxus-paragraph id="paragraph-2-1">First Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2-2">Second Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "hub",
        root: undefined,
      });

      expect(firstBlock?.id).toBe("note-1");
    });

    it("should return first block with any role in the array when found", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1-1">First Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-1-2">Second Paragraph</myoxus-paragraph>
          </myoxus-note>
          <myoxus-note id="note-2">
            <myoxus-paragraph id="paragraph-2-1">First Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2-2">Second Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: ["hub", "content"],
        root: undefined,
      });

      expect(firstBlock?.id).toBe("note-1");
    });

    it("should return first block with specified flavour when found", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Paragraph</myoxus-paragraph>
            <myoxus-list id="list-1">List Item</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        flavour: "myoxus:list",
        root: note,
      });

      expect(firstBlock?.id).toBe("list-1");
    });

    it("should return first block with any flavour in the array when found", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Paragraph</myoxus-paragraph>
            <myoxus-list id="list-1">List Item</myoxus-list>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        flavour: ["myoxus:list", "myoxus:code"],
        root: note,
      });

      expect(firstBlock?.id).toBe("list-1");
    });

    it("should return first block matching both role and flavour when both specified", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Content Paragraph</myoxus-paragraph>
            <myoxus-list id="list-1">Content List</myoxus-list>
            <myoxus-paragraph id="paragraph-2">hub Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;
      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "content",
        flavour: "myoxus:list",
        root: note,
      });

      expect(firstBlock?.id).toBe("list-1");
    });

    it("should return first block with default roles when role not specified", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">hub Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">Content Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-3">Hub Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        root: undefined,
      });

      expect(firstBlock?.id).toBe("note-1");
    });

    it("should return first block with specified role when found", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Content Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">hub Paragraph</myoxus-paragraph>
            <myoxus-database id="database-1">Database</myoxus-database>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "hub",
        root: note,
      });

      expect(firstBlock?.id).toBe("database-1");
    });

    it("should return null when no blocks with specified role are found in children", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Content Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">Another Content Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "hub",
        root: note,
      });

      expect(firstBlock).toBeNull();
    });

    it("should return null when no blocks with specified flavour are found in children", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1">Paragraph</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2">Another Paragraph</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-1")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        flavour: "myoxus:list",
        root: note,
      });

      expect(firstBlock).toBeNull();
    });

    it("should return first block with specified role within specified root subtree", () => {
      const host = myoxus`
        <myoxus-page>
          <myoxus-note id="note-1">
            <myoxus-paragraph id="paragraph-1-1">1-1 Content</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-1-2">1-2 hub</myoxus-paragraph>
          </myoxus-note>
          <myoxus-note id="note-2">
            <myoxus-paragraph id="paragraph-2-1">2-1 hub</myoxus-paragraph>
            <myoxus-paragraph id="paragraph-2-2">2-2 Content</myoxus-paragraph>
          </myoxus-note>
        </myoxus-page>
      `;

      const note = host.store.getBlock("note-2")?.model;

      const [_, { firstBlock }] = host.command.exec(getFirstBlockCommand, {
        role: "content",
        root: note,
      });

      expect(firstBlock?.id).toBe("paragraph-2-1");
    });
  });
});
