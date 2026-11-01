// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal } from "@preact/signals-core";
import { editorMessage } from "@virgultum/shared/services";
import { describe, expect, it } from "vitest";

import type { SlashMenuContext } from "../types.js";
import {
  assertStableSlashMenuItemIdentities,
  buildSlashMenuItems,
  getSlashMenuItemSearchTerms,
  getSlashMenuSearchScore,
  parseGroup,
} from "../utils.js";

const context = {} as SlashMenuContext;

describe("slash-menu identity and localization contract", () => {
  it("keeps stable ids independent from localized labels", () => {
    const item = {
      id: "block-image-insert",
      label: editorMessage("Image", "Image"),
      searchAlias: [
        editorMessage("com.myoxus.editor.test.picture", "picture"),
        editorMessage("com.myoxus.editor.test.localized-picture", "Bild"),
      ],
      action: () => {},
    };

    assertStableSlashMenuItemIdentities([item]);
    const i18n = {
      locale$: signal("de"),
      translate: (message: { key: string; fallback: string }) =>
        message.key === "Image" ? "Bild" : message.fallback,
    };
    expect(getSlashMenuItemSearchTerms(item, i18n)).toEqual([
      "Bild",
      "Image",
      "picture",
    ]);
  });

  it.each(["verkn", "link", "Dokument"])(
    "ranks document linking before unrelated fuzzy matches for %s",
    (query) => {
      const link = {
        id: "document-link",
        label: editorMessage("test.link", "Link document"),
        searchAlias: ["verknüpftes Dokument", "link document"],
        action: () => {},
      };
      const i18n = {
        locale$: signal("de"),
        translate: (message: { key: string; fallback: string }) =>
          message.key === "test.link" ? "Dokument verlinken" : message.fallback,
      };
      const others = [
        "Ereignis",
        "Mermaid-Diagramm",
        "Tabelle",
        "Neues Dokument",
      ].map((name) => ({ name, action: () => {} }));
      const ranked = [...others, link].sort(
        (a, b) =>
          getSlashMenuSearchScore(b, query, i18n) -
          getSlashMenuSearchScore(a, query, i18n),
      );
      expect(ranked[0]).toBe(link);
    },
  );

  it("prioritizes exact translated labels over alias prefixes", () => {
    const exact = { name: "Link", action: () => {} };
    const prefix = {
      name: "Other",
      searchAlias: ["link document"],
      action: () => {},
    };
    expect(getSlashMenuSearchScore(exact, "link")).toBeGreaterThan(
      getSlashMenuSearchScore(prefix, "link"),
    );
  });

  it("sorts typed groups numerically without using translated labels", () => {
    const items = buildSlashMenuItems(
      [
        {
          id: "action-later",
          label: editorMessage("com.myoxus.editor.test.later", "Later"),
          group: {
            id: "actions",
            label: editorMessage("com.myoxus.actions", "Actions"),
            order: 8,
            itemOrder: 1,
          },
          action: () => {},
        },
        {
          id: "action-first",
          label: editorMessage("com.myoxus.editor.test.first", "First"),
          group: {
            id: "actions",
            label: editorMessage("com.myoxus.actions", "Actions"),
            order: 8,
            itemOrder: 0,
          },
          action: () => {},
        },
      ],
      context,
    );

    expect(items.map((item) => item.id)).toEqual([
      "action-first",
      "action-later",
    ]);
    expect(parseGroup(items[0].group!)).toMatchObject({
      groupId: "actions",
      itemIndex: 0,
    });
  });

  it("rejects duplicate or malformed migrated ids", () => {
    expect(() =>
      assertStableSlashMenuItemIdentities([
        {
          id: "Action Copy",
          label: editorMessage("Copy", "Copy"),
          action: () => {},
        },
      ]),
    ).toThrow("Invalid slash-menu id");

    const item = {
      id: "action-copy",
      label: editorMessage("Copy", "Copy"),
      action: () => {},
    };
    expect(() => assertStableSlashMenuItemIdentities([item, item])).toThrow(
      "Duplicate slash-menu id",
    );
  });

  it("keeps the bounded legacy parser available for excluded configurations", () => {
    expect(parseGroup("4_Content & Media@2")).toMatchObject({
      groupIndex: 4,
      groupId: "Content & Media",
      itemIndex: 2,
    });
  });
});
