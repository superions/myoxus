// SPDX-License-Identifier: AGPL-3.0-or-later

import { createIdentifier } from "../primitives/di/index";
import type {
  DocumentIndexProps,
  DocumentIndexBlockModel,
  DocumentIndexQuery,
} from "../models/index";
import type { BlockStdScope } from "../runtime/index";
import type { TemplateResult } from "lit";

export type DocumentIndexRow = { title: string; href: string };
export type DocumentIndexTable = {
  headers: string[];
  rows: { text: string; href?: string }[][];
};
export interface DocumentIndexOutputProvider {
  resolveTable(
    props: DocumentIndexProps,
    workspaceId?: string,
  ): Promise<DocumentIndexTable>;
  resolve(
    query: DocumentIndexQuery,
    workspaceId?: string,
  ): Promise<DocumentIndexRow[]>;
  readonly emptyText: string;
}
export const DocumentIndexOutputProvider =
  createIdentifier<DocumentIndexOutputProvider>("DocumentIndexOutputProvider");
export interface DocumentIndexHost {
  render(model: DocumentIndexBlockModel, std: BlockStdScope): TemplateResult;
  configure(
    props: DocumentIndexProps,
    apply: (value: DocumentIndexProps) => void,
    close: () => void,
    docId: string,
  ): TemplateResult;
}
export const DocumentIndexHost =
  createIdentifier<DocumentIndexHost>("DocumentIndexHost");
