// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "../../store/index";

export type DocumentIndexFilter = {
  key: string;
  method: string;
  value?: string | null;
};
export type DocumentIndexQuery = {
  folderId?: string | null;
  subtree: boolean;
  tagIds: string[];
  matchAllTags: boolean;
  filters: DocumentIndexFilter[];
  orderBy?: { type: "system"; key: string; desc: boolean } | null;
};
export type DocumentIndexProps = {
  title: string;
  view: "list" | "table";
  displayProperties: string[];
  workspaceId?: string;
  query: DocumentIndexQuery;
};
export function defaultDocumentIndexProps(): DocumentIndexProps {
  return {
    title: "",
    view: "list",
    displayProperties: ["system:title"],
    workspaceId: undefined,
    query: { subtree: false, tagIds: [], matchAllTags: false, filters: [] },
  };
}
/** Only authored selection is durable. Inventory, counts and grants are transient. */
export const DocumentIndexBlockSchema = defineBlockSchema({
  flavour: "myoxus:document-index",
  props: defaultDocumentIndexProps,
  metadata: {
    version: 1,
    role: "content",
    parent: ["myoxus:note", "myoxus:paragraph", "myoxus:list"],
    children: [],
  },
  toModel: () => new DocumentIndexBlockModel(),
});
export const DocumentIndexBlockSchemaExtension = BlockSchemaExtension(
  DocumentIndexBlockSchema,
);
export class DocumentIndexBlockModel extends BlockModel<DocumentIndexProps> {}
