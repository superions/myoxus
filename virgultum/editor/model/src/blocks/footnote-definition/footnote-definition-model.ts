// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";

export type FootnotePlacement = "footnote" | "endnote";

/** Absence in existing native snapshots means footnote; malformed values stay invalid. */
export function footnotePlacement(
  value: unknown,
): FootnotePlacement | undefined {
  return value === undefined || value === "footnote"
    ? "footnote"
    : value === "endnote"
      ? "endnote"
      : undefined;
}
export type FootnoteDefinitionProps = {
  label: string;
  placement: FootnotePlacement;
};

/** Ordinary editable children remain in the parent's Yjs tree and history. */
export const FootnoteDefinitionBlockSchema = defineBlockSchema({
  flavour: "myoxus:footnote-definition",
  props: (): FootnoteDefinitionProps => ({ label: "", placement: "footnote" }),
  metadata: {
    version: 1,
    role: "content",
    parent: ["myoxus:note"],
    children: [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:code",
      "myoxus:table",
      "myoxus:image",
      "myoxus:mermaid",
      "myoxus:latex",
      "myoxus:callout",
      "myoxus:annotation",
      "myoxus:divider",
    ],
  },
  toModel: () => new FootnoteDefinitionBlockModel(),
});
export const FootnoteDefinitionBlockSchemaExtension = BlockSchemaExtension(
  FootnoteDefinitionBlockSchema,
);
export class FootnoteDefinitionBlockModel extends BlockModel<FootnoteDefinitionProps> {}
