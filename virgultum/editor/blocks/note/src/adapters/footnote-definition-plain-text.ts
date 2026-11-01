// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BlockPlainTextAdapterExtension,
  LOCAL_FOOTNOTE_READING_PREFIX,
} from "@virgultum/shared/adapters";

export const footnoteDefinitionPlainTextAdapter =
  BlockPlainTextAdapterExtension({
    flavour: "myoxus:footnote-definition",
    toMatch: () => false,
    fromMatch: ({ node }) => node.flavour === "myoxus:footnote-definition",
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: ({ node }, { textBuffer, configs }) => {
        const raw = configs.get(LOCAL_FOOTNOTE_READING_PREFIX + node.id);
        if (!raw) throw new Error("Missing native note reading projection");
        const reading = JSON.parse(raw) as { name: string; placement?: string };
        if (!reading.placement)
          throw new Error("Invalid native footnote placement");
        textBuffer.content += `\n${reading.name}:\n`;
      },
    },
  });
