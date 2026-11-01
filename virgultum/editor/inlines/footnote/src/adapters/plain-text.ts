// SPDX-License-Identifier: AGPL-3.0-or-later
import { FootNoteSchema } from "@virgultum/model";
import {
  InlineDeltaToPlainTextAdapterExtension,
  LOCAL_FOOTNOTE_READING_PREFIX,
} from "@virgultum/shared/adapters";

export const localFootnoteDeltaToPlainText =
  InlineDeltaToPlainTextAdapterExtension({
    name: "local-footnote",
    match: (delta) => delta.attributes?.footnote?.definitionId !== undefined,
    toAST: (delta, { configs }) => {
      const id = FootNoteSchema.parse(delta.attributes?.footnote).definitionId;
      const raw = configs.get(LOCAL_FOOTNOTE_READING_PREFIX + id);
      const reading = raw
        ? (JSON.parse(raw) as { name: string; marker: string })
        : undefined;
      return {
        content: (reading ? `[${reading.name}]` : "[?]").repeat(
          delta.insert.length,
        ),
      };
    },
  });
